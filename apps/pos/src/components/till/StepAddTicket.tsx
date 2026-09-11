import { useMemo } from 'react';
import { TicketType, CustomerTier, CartLine, AddOnVariantQty } from '@/types';
import { getTicketTypes, getAddOns } from '@/mockApi';
import { Button } from '@/components/ui/button';
import { TicketCard } from './TicketCard';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { AddOnsGrid } from './AddOnsGrid';
import { setAddOnQty, setAddOnVariants } from '@/lib/pricing';
import { ArrowLeft, Baby, User, HandHeart, Ticket, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

function ParticipantStepper({
  icon: Icon,
  label,
  description,
  price,
  value,
  max,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  price?: number;
  value: number;
  max?: number;
  onChange: (next: number) => void;
}) {
  const active = value > 0;
  return (
    <Card
      className={`p-4 flex flex-col gap-3 ${
        active ? 'border-primary bg-primary/10 ring-1 ring-primary' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
            active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
          }`}
        >
          <Icon className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-lg leading-tight">{label}</div>
          {description && <div className="text-xs text-muted-foreground truncate">{description}</div>}
          {typeof price === 'number' && (
            <div className="text-xs text-primary font-medium mt-0.5">฿{price} each</div>
          )}
          {typeof max === 'number' && max === 0 && (
            <div className="text-xs text-destructive font-medium mt-0.5">Out of stock</div>
          )}
        </div>
      </div>
      <div className="flex justify-center">
        <QuantityStepper value={value} max={max} onChange={onChange} ariaLabel={label} />
      </div>
    </Card>
  );
}

interface StepAddTicketProps {
  tier: CustomerTier;
  activeLine: CartLine | null;
  hasLines: boolean;
  onSelectTicket: (ticket: TicketType) => void;
  onUpdateLine: (id: string, updates: Partial<Pick<CartLine, 'kids' | 'adults' | 'socks' | 'addOns'>>) => void;
  onAddDropOff: () => void;
  onBackToGrid: () => void;
  onDone: () => void;
  // Hide the "Add drop-off child" action. Used when ticketing into a party tab,
  // where drop-off (a supervised-care registration) isn't part of the charge.
  hideDropOff?: boolean;
}

export function StepAddTicket({
  tier,
  activeLine,
  hasLines,
  onSelectTicket,
  onUpdateLine,
  onAddDropOff,
  onBackToGrid,
  onDone,
  hideDropOff = false,
}: StepAddTicketProps) {
  const tickets = useMemo(() => getTicketTypes(), []);
  const allAddOns = useMemo(() => getAddOns(), []);

  if (!activeLine) {
    return (
      <div className="flex flex-col h-full animate-in fade-in slide-in-from-right-4 duration-300">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold tracking-tight">Add to Sale</h2>
          <div className="flex items-center gap-3">
            {!hideDropOff && (
              <Button variant="outline" size="lg" className="gap-2" onClick={onAddDropOff}>
                <HandHeart className="w-5 h-5" />
                Add drop-off child
              </Button>
            )}
            {hasLines && (
              <Button variant="secondary" size="lg" onClick={onDone}>
                Done Adding
              </Button>
            )}
          </div>
        </div>

        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Ticket className="w-4 h-4" />
          <span>Add ticket — select a play ticket for kids and adults</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {tickets.map((t) => (
            <TicketCard key={t.id} ticket={t} tier={tier} onClick={() => onSelectTicket(t)} />
          ))}
        </div>
      </div>
    );
  }

  const setAddOnQuantity = (addOnId: string, quantity: number, variantId?: string) => {
    onUpdateLine(activeLine.id, {
      addOns: setAddOnQty(activeLine.addOns, allAddOns, addOnId, quantity, variantId),
    });
  };

  const setAddOnVariantsForLine = (addOnId: string, breakdown: AddOnVariantQty[]) => {
    onUpdateLine(activeLine.id, {
      addOns: setAddOnVariants(activeLine.addOns, allAddOns, addOnId, breakdown),
    });
  };

  return (
    <div className="flex flex-col h-full animate-in slide-in-from-bottom-4 duration-300">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-3xl font-bold tracking-tight">Configure: {activeLine.ticketType.name}</h2>
        <Button variant="ghost" className="gap-2" onClick={onBackToGrid}>
          <ArrowLeft className="w-4 h-4" />
          Back to tickets
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-6">
        <div>
          <h3 className="text-xl font-semibold mb-3">Participants</h3>
          <div className="grid grid-cols-2 gap-4">
            <ParticipantStepper
              label="Kids"
              description="Requires adult supervision"
              icon={Baby}
              value={activeLine.kids}
              onChange={(v) => onUpdateLine(activeLine.id, { kids: v })}
            />
            <ParticipantStepper
              label="Adults"
              description="Receives F&B credit"
              icon={User}
              value={activeLine.adults}
              onChange={(v) => onUpdateLine(activeLine.id, { adults: v })}
            />
          </div>
        </div>

        <div>
          <h3 className="text-xl font-semibold mb-3">Extras &amp; Add-ons</h3>
          <AddOnsGrid
            selected={activeLine.addOns}
            onSetQuantity={setAddOnQuantity}
            onSetVariants={setAddOnVariantsForLine}
          />
        </div>
      </div>

      <div className="mt-6 pt-6 border-t grid grid-cols-2 gap-4">
        <Button variant="outline" size="lg" className="h-16 text-lg" onClick={onBackToGrid}>
          Add Another Ticket
        </Button>
        <Button size="lg" className="h-16 text-xl font-bold" onClick={onDone}>
          Continue
        </Button>
      </div>
    </div>
  );
}
