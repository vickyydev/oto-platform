import { supervisedLineCreditOfCart } from '@oto/shared';
import type { SupervisedSlot } from '@/components/till/SupervisionGate';
import type { ChildFoodProvision, CustomerTier, TicketType } from '@/types';
import { engineCartLine, pricingContext } from '@/lib/cartWire';
import { priceForTier } from '@/lib/pricing';

/**
 * SCRUM-1021 — THE FOOD CREDIT ON THE DROP-OFF AND NANNY FORM (the owner's
 * answers of 19 November 2026).
 *
 * A supervised child on a ticket that includes food credit (Eat & Play) has
 * the ticket's credit put on their band at check-in (`loadChildIncludedCredit`
 * in the api), and the form shows it as included, with no extra charge. The
 * parent chooses any EXTRA prepaid food credit on their own screen; staff see
 * the choice on the till as it is made, and it is its own row on the order.
 */

/**
 * The credit one child on this ticket will find on their band, in whole baht:
 * the platform's grant law for one kid on a supervised line
 * (`supervisedLineCreditOfCart`), at the sale's tier and today's rate mode.
 * Zero for a ticket whose credit is for adults only, or that has none; zero
 * for a Golden Ticket's child, whose gift is free entry with no food voucher.
 */
export function includedCreditTHB(ticket: TicketType, tier: CustomerTier, gift = false): number {
  const line = engineCartLine({
    id: 'included-credit',
    ticketType: ticket,
    tier,
    kids: 1,
    adults: 0,
    socks: 0,
    addOns: [],
    lineTotal: priceForTier(ticket, tier),
  });
  const packages = new Map([
    [ticket.id, { creditRule: ticket.creditRule ?? null, gateAccess: ticket.gateAccess ?? false }],
  ]);
  return supervisedLineCreditOfCart(line, pricingContext(), packages, gift) / 100;
}

/**
 * The extra prepaid food credit the till holds for a child, in whole baht, as
 * the family's screen is asked to choose it; null where the family is not
 * asked: staff chose prepaid items for the child on the till (their choice
 * stands, and the screen shows no credit to choose).
 */
export function extraCreditOfSlot(slot: Pick<SupervisedSlot, 'foodProvision'>): number | null {
  const fp = slot.foodProvision;
  if (fp?.mode === 'prepaid_items') return null;
  if (fp?.mode !== 'prepaid_credit') return 0;
  return Math.max(0, Math.round(fp.creditAmountTHB ?? fp.paidTHB));
}

/**
 * SCRUM-1054 — THE PARENT'S TICK: "MAY ORDER FOOD WITH THE INCLUDED CREDIT"
 * (the owner's answer of 19 November, R3). Without extra food the
 * registration says "no food" and the food counter asks a manager, although
 * the ticket's credit is on the band; the form asks the parent this one tick.
 *
 * Asked for a child whose ticket includes credit, wherever the form asks the
 * family's extra credit (not over prepaid items staff chose): the display's
 * form is sent the tick then, so it never comes and goes under the family's
 * own − and + presses.
 */
export function asksOrderWithIncluded(slot: Pick<SupervisedSlot, 'foodProvision'>, includedTHB: number): boolean {
  return includedTHB > 0 && extraCreditOfSlot(slot) !== null;
}

/** Shown on the form: asked, and the parent chose no extra food. With extra food the child may order as before. */
export function showsOrderWithIncluded(slot: Pick<SupervisedSlot, 'foodProvision'>, includedTHB: number): boolean {
  return asksOrderWithIncluded(slot, includedTHB) && extraCreditOfSlot(slot) === 0;
}

/**
 * SCRUM-1054 — the children whose tick the registration did not keep. The
 * counter box's lane does not carry the tick (`checkinApi.createRegistration`),
 * so a registration that went to the box after the parent ticked has the child
 * as "no food": the stay the registration answers with says so, and the till
 * tells staff with these names that the food counter will ask a manager.
 */
export function includedTicksDropped(
  sent: readonly { checkinId: string; name: string; orderWithIncludedCredit?: boolean }[],
  kept: readonly { id: string; mayOrderFood: boolean }[],
): string[] {
  return sent.flatMap((child) => {
    if (child.orderWithIncludedCredit !== true) return [];
    const stay = kept.find((item) => item.id === child.checkinId);
    return stay && !stay.mayOrderFood ? [child.name || 'A child'] : [];
  });
}

/** What staff are told when `includedTicksDropped` names any child. */
export function includedTicksDroppedNotice(names: readonly string[]): { title: string; description: string } {
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
  return {
    title: 'Food with the included credit needs the internet',
    description: `${who} ${names.length === 1 ? 'is' : 'are'} registered without the family’s tick: the food counter will ask a manager before an order.`,
  };
}

/** What the registration says for the child: the tick, only where the form shows it. */
export function ordersWithIncluded(
  slot: Pick<SupervisedSlot, 'foodProvision' | 'orderWithIncludedCredit'>,
  includedTHB: number,
): boolean {
  return slot.orderWithIncludedCredit === true && showsOrderWithIncluded(slot, includedTHB);
}

/**
 * The family's choice on their screen, as the child's food on the till: that
 * much prepaid credit, or none. Never over prepaid items staff chose (the
 * form does not ask then). `mayOrderFood` follows the provision exactly as
 * the till's own picker sets it (an amount paid, or not).
 */
export function slotFoodFromFamily(
  slot: Pick<SupervisedSlot, 'foodProvision'>,
  extraTHB: number,
): Pick<SupervisedSlot, 'foodProvision' | 'mayOrderFood'> | null {
  if (slot.foodProvision?.mode === 'prepaid_items') return null;
  const amount = Math.max(0, Math.round(extraTHB));
  if (extraCreditOfSlot(slot) === amount && (amount > 0 || slot.foodProvision)) return null;
  const foodProvision: ChildFoodProvision =
    amount > 0 ? { mode: 'prepaid_credit', creditAmountTHB: amount, paidTHB: amount } : { mode: 'none', paidTHB: 0 };
  return { foodProvision, mayOrderFood: amount > 0 };
}
