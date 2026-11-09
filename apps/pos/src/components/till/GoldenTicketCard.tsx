import { useState } from 'react';
import { Gift } from 'lucide-react';
import type { GiftTicketChoice } from '@oto/shared';
import { Button } from '@/components/ui/button';
import type { TicketType } from '@/types';
import {
  giftTicketChoicesFor,
  giftTicketDropOffMinAge,
  type GiftTicketRequest,
} from '@/lib/giftTicket';
import type { HeldVoucher } from '@/lib/tillVoucher';

/**
 * SCRUM-798 — THE GOLDEN TICKET ON THE TICKET SCREEN, under the voucher's card
 * and in its clothes: what the gift gives, the child's age, the family's
 * choice, the socks — and the press that rings it up (`lib/giftTicket.ts`).
 *
 * It decides nothing about money. The figure on the voucher's card is the
 * platform's, and Pay waits for it as for any voucher. What it holds back is
 * only the owner's rule: drop-off is offered from age 5, and under 5 the
 * parent stays.
 */

/** The ages the picker offers: a child's ticket, under 1 to 17. */
const AGES = Array.from({ length: 18 }, (_, age) => age);

interface GoldenTicketCardProps {
  held: HeldVoucher;
  /** The package on this till's catalogue, or null when this till sells none. */
  ticket: TicketType | null;
  /** What the gift's line holds now, once it is rung up. */
  onCart: { adults: number; socks: number; dropOff: boolean } | null;
  busy?: boolean;
  disabled?: boolean;
  onRingUp: (request: GiftTicketRequest) => void;
}

export function GoldenTicketCard({ held, ticket, onCart, busy, disabled, onRingUp }: GoldenTicketCardProps) {
  const effect = held.view.effect;
  const packageName = effect.type === 'gift_ticket' ? effect.package.name : 'Full Day Pass';
  const minAge = giftTicketDropOffMinAge(held);
  const [age, setAge] = useState<number | null>(null);
  const [choice, setChoice] = useState<GiftTicketChoice | null>(null);
  const [socks, setSocks] = useState(false);
  const choices = giftTicketChoicesFor(age, minAge);
  // An age that no longer allows drop-off takes the choice back.
  const chosen = choice !== null && choices.includes(choice) ? choice : null;
  const ready = age !== null && chosen !== null && ticket !== null;
  const ringUp = () => {
    if (age === null || chosen === null || ticket === null || busy || disabled) return;
    onRingUp({ childAgeYears: age, choice: chosen, socks });
  };

  return (
    <div className="rounded-lg bg-emerald-500/10 p-3 text-emerald-500 space-y-2.5" data-testid="golden-ticket">
      <div className="flex items-start gap-2">
        <Gift className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium leading-tight">{held.view.prize.nameEn} — what it gives</div>
          <ul className="mt-1 text-xs leading-snug text-emerald-400 space-y-0.5" data-testid="golden-ticket-gift">
            <li>{packageName} for one child</li>
            <li>Parent enters free with an adult band, or drop-off for a child aged {minAge} or over</li>
            <li>One free pair of Regular Socks on request</li>
            <li>No food credit</li>
          </ul>
        </div>
      </div>

      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-emerald-400">Child&apos;s age</span>
        <select
          value={age === null ? '' : String(age)}
          onChange={(e) => setAge(e.target.value === '' ? null : Number(e.target.value))}
          aria-label="Child's age"
          className="h-9 min-w-0 rounded-xl border border-foreground/10 bg-black/20 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          disabled={disabled || busy}
        >
          <option value="">Ask the age…</option>
          {AGES.map((a) => (
            <option key={a} value={a}>
              {a === 0 ? 'Under 1' : `${a} ${a === 1 ? 'year' : 'years'}`}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          variant={chosen === 'parent_stays' ? 'default' : 'outline'}
          className="h-auto whitespace-normal py-1.5"
          disabled={disabled || busy || !choices.includes('parent_stays')}
          onClick={() => setChoice('parent_stays')}
        >
          Parent stays
        </Button>
        <Button
          type="button"
          size="sm"
          variant={chosen === 'drop_off' ? 'default' : 'outline'}
          className="h-auto whitespace-normal py-1.5"
          disabled={disabled || busy || !choices.includes('drop_off')}
          onClick={() => setChoice('drop_off')}
        >
          Drop-off
        </Button>
      </div>
      {age !== null && !choices.includes('drop_off') && (
        <div className="text-xs leading-snug text-amber-400" data-testid="golden-ticket-under-age">
          Under {minAge}, the parent stays with the child — drop-off is from age {minAge}.
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-emerald-400">
        <input
          type="checkbox"
          checked={socks}
          onChange={(e) => setSocks(e.target.checked)}
          disabled={disabled || busy}
          aria-label="Free pair of Regular Socks"
        />
        Free pair of Regular Socks
      </label>

      {!ticket && (
        <div className="text-xs leading-snug text-amber-400">
          This till has no {packageName} to ring the Golden Ticket up on — ask a manager.
        </div>
      )}
      {onCart && (
        <div className="text-xs leading-snug text-emerald-400" data-testid="golden-ticket-on-cart">
          On this sale: one child
          {onCart.dropOff ? ', dropped off' : onCart.adults > 0 ? ', the parent free' : ''}
          {onCart.socks > 0 ? ', one pair of socks' : ''}.
        </div>
      )}
      <Button
        type="button"
        size="sm"
        className="h-auto w-full whitespace-normal py-1.5"
        disabled={!ready || busy || disabled}
        onClick={ringUp}
        data-testid="golden-ticket-ring-up"
      >
        {chosen === 'drop_off'
          ? 'Ring up and open the Drop-Off form'
          : onCart
            ? 'Update the Golden Ticket'
            : 'Ring up the Golden Ticket'}
      </Button>
    </div>
  );
}
