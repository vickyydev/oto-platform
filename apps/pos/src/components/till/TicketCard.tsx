import { TicketType, CustomerTier } from '@/types';
import { priceForTier } from '@/lib/pricing';
import { Card } from '@/components/ui/card';
import { Clock } from 'lucide-react';

interface TicketCardProps {
  ticket: TicketType;
  tier: CustomerTier;
  onClick: () => void;
  selected?: boolean;
}

export function TicketCard({ ticket, tier, onClick, selected }: TicketCardProps) {
  return (
    <Card 
      className={`p-6 cursor-pointer transition-all active:scale-[0.98] ${selected ? 'border-primary bg-primary/10 shadow-md ring-1 ring-primary' : 'hover:border-primary/50'}`}
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="font-bold text-xl">{ticket.name}</h3>
          <div className="flex items-center text-muted-foreground text-sm mt-1 gap-1">
            <Clock className="h-4 w-4" />
            <span>{ticket.durationLabel}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold text-xl text-primary">฿{priceForTier(ticket, tier)}</div>
          <div className="text-xs text-muted-foreground">per person</div>
        </div>
      </div>
    </Card>
  );
}
