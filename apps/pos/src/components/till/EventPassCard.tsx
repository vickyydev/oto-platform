import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { OtoEvent } from '@/types';
import { resolveRateToday } from '@/lib/pricingMode';
import { Ticket, Tent, Sparkles } from 'lucide-react';

// One sellable event pass: title, type, schedule and flat entry price. Selling a
// pass is a self-contained flow (capture → pay → check-in choice) that never
// touches the tier cart, so it can be offered both at the identify step and the
// customer-type step without duplicating the sale logic.
//
// THE ROW WRAPS WHEN THE COLUMN IS NARROW — SCRUM-436. With the test harness's
// customer display open beside the till at 1600 px, the Membership Check
// column is 390 px wide, and this card is the widest thing in it: a title that
// never wraps (`truncate`), a price and a button, none of which could give way.
// The column's scroll area sizes its content to its widest child, so the whole
// column was laid out at this card's width and clipped on the right — "…look
// up membe", "฿6". Three things let it give way, and none of them moves a
// pixel while there is room, which there always is with the display closed:
//   - the card wraps, and the price and button wrap together as one trailing
//     group that keeps to the right edge (`ml-auto`) when it drops a row;
//   - the title block starts at 10rem and grows, so the group drops before
//     the title is squeezed to nothing;
//   - the title block's intrinsic width is not counted (`contain-inline-size`):
//     a title that cannot wrap would otherwise still set the column's width.
export function EventPassCard({
  event,
  onSell,
}: {
  event: OtoEvent;
  onSell: (event: OtoEvent) => void;
}) {
  const Icon = event.type === 'camp' ? Tent : Sparkles;
  const fee = resolveRateToday(event.entryPriceTHB);
  return (
    <Card className="p-4 flex flex-wrap items-center gap-4 bg-card/50">
      <div className="h-11 w-11 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0 grow shrink basis-40 contain-inline-size">
        <div className="flex items-center gap-2 font-bold flex-wrap">
          <span className="truncate">{event.title}</span>
          <span className="text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
            {event.type === 'camp' ? 'Camp' : 'Event'}
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {event.startTime} – {event.endTime} · {event.location}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-4 shrink-0">
        <div className="text-right shrink-0">
          <div className="text-lg font-black tabular-nums leading-none">฿{fee}</div>
          <div className="text-[11px] text-muted-foreground">per day</div>
        </div>
        <Button className="shrink-0 h-11" onClick={() => onSell(event)}>
          <Ticket className="w-4 h-4 mr-1.5" />
          Sell pass
        </Button>
      </div>
    </Card>
  );
}
