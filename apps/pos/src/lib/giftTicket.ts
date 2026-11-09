import {
  GIFT_TICKET_DROP_OFF_MIN_AGE,
  giftTicketChoices,
  giftTicketEntitlement,
  type GiftTicketChoice,
  type GiftTicketEntitlement,
} from '@oto/shared';
import type { CartLine, CustomerTier, TicketType } from '@/types';
import { computeLineTotal } from '@/lib/pricing';
import type { HeldVoucher } from '@/lib/tillVoucher';

/**
 * SCRUM-798 — THE GOLDEN TICKET AT THE TICKET TILL.
 *
 * The owner's definition (9 November 2026): "Gift voucher for full-day entry
 * for one child, with free socks if needed. For kids 5 and up, the parent can
 * choose free drop-off or stay with the child. If the parent stays, print an
 * adult wristband for free entry with no food voucher. For kids under 5, the
 * parent stays and gets the same free entry and adult wristband. Please link
 * the Drop-Off Form only when drop-off is selected for a child aged 5 or
 * older."
 *
 * What the till decides here is only WHAT TO RING UP: one Full Day Pass line
 * for the child, with the parent on it when they stay and a pair of socks when
 * asked for, marked as the gift's line. What it is worth is the platform's
 * (`voucherPricing` prices the gift from the voucher, and the payment step
 * waits for that figure), and the rule of who may be dropped off is the shared
 * one (`giftTicketEntitlement` in `@oto/shared`), so the till and the platform
 * read the same sentence. A drop-off goes through the counter's own Drop-Off
 * form on the customer display, exactly as a paid drop-off does.
 */

/** The voucher on this cart is a Golden Ticket. */
export function isGiftTicket(held: HeldVoucher | null): boolean {
  return held?.view.effect.type === 'gift_ticket';
}

/** The package the gift admits to, as this till's catalogue has it: by the platform's id, else by name. */
export function giftTicketPackage(held: HeldVoucher | null, tickets: readonly TicketType[]): TicketType | null {
  const effect = held?.view.effect;
  if (!effect || effect.type !== 'gift_ticket') return null;
  return (
    tickets.find((t) => t.id === effect.package.id) ??
    tickets.find((t) => t.name.trim().toLowerCase() === effect.package.name.trim().toLowerCase()) ??
    null
  );
}

/** The youngest age drop-off is offered at, as the voucher says (the owner's 5). */
export function giftTicketDropOffMinAge(held: HeldVoucher | null): number {
  const effect = held?.view.effect;
  return effect && effect.type === 'gift_ticket' ? effect.dropOffMinAge : GIFT_TICKET_DROP_OFF_MIN_AGE;
}

/** What the family asked for at the counter. */
export interface GiftTicketRequest {
  childAgeYears: number | null;
  choice: GiftTicketChoice;
  socks: boolean;
}

/** The choices this child is offered, or none until the age is asked. */
export function giftTicketChoicesFor(childAgeYears: number | null, minAge: number): GiftTicketChoice[] {
  return childAgeYears === null ? [] : giftTicketChoices(childAgeYears, minAge);
}

/** The owner's rule for this request, as the platform reads it. */
export function giftTicketRequestEntitlement(request: GiftTicketRequest, minAge: number): GiftTicketEntitlement {
  return giftTicketEntitlement(request.childAgeYears, request.choice, minAge);
}

/**
 * THE GIFT'S LINE: one child on the package; the parent on it when they stay
 * (their adult band prints with the sale, as for any Full Day sale); a drop-off
 * leaves no adult on it, which is what sends it through the Drop-Off form; one
 * pair of socks when asked for. Priced as any line is, so the screen's figure
 * matches the platform's before the voucher comes off it.
 */
export function buildGiftTicketLine(
  ticket: TicketType,
  tier: CustomerTier,
  request: GiftTicketRequest,
  id: string,
): CartLine {
  const base = {
    ticketType: ticket,
    tier,
    kids: 1,
    adults: request.choice === 'parent_stays' ? 1 : 0,
    socks: request.socks ? 1 : 0,
    addOns: [],
  };
  return { id, ...base, lineTotal: computeLineTotal(base), voucherGift: true };
}

/**
 * Put the gift's line on the cart: in place of the gift line already there
 * (the family changed their mind before paying), else after everything else.
 * A drop-off line the gift became is replaced too, so asking again starts from
 * the answer given now.
 */
export function placeGiftTicketLine(lines: readonly CartLine[], giftLine: CartLine): CartLine[] {
  const at = lines.findIndex((l) => l.voucherGift);
  if (at < 0) return [...lines, giftLine];
  return lines.map((l, i) => (i === at ? giftLine : l)).filter((l, i) => i === at || !l.voucherGift);
}

/** The cart with the gift taken back off it: the voucher is gone, so its line is an ordinary one again. */
export function dropGiftTicketMarks(lines: readonly CartLine[]): CartLine[] {
  return lines.some((l) => l.voucherGift)
    ? lines.map((l) => {
        if (!l.voucherGift) return l;
        const { voucherGift: _gift, ...rest } = l;
        return rest;
      })
    : (lines as CartLine[]);
}
