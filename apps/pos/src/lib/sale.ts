import {
  CartLine,
  CustomerTier,
  Discount,
  ManualDiscount,
  Sale,
  SaleQuotedPricing,
  TicketCreditRule,
  CreditGrant,
} from '@/types';
import { priceForTier, resolveAdultLine } from '@/lib/pricing';
import { resolveFreeItem } from '@/lib/promoVoucher';
import { ticketTotals } from '@/lib/cartWire';

/*
 * SCRUM-271 — THE TILL'S OLDER CALCULATOR USED TO START HERE: `tillTaxInputs`
 * and `computeTotals`, the prototype's baht-float totals, which the till, the
 * customer display, the history screens, the parties, the booking page and the
 * reports all read. They are gone; a ticket cart's totals come from the satang
 * engine through `ticketTotals` (`lib/cartWire.ts`), and the figures they
 * showed are pinned against the prototype's in
 * `apps/pos/test/one-calculator-parity.test.ts`. What stays in this file is the
 * sale record itself — the credit grants and the bands a sale issues.
 */

/**
 * The F&B/merch credit (฿) one person earns from a ticket's give-back rule,
 * given the ฿ they actually paid. full_price → the price paid; fixed → value ฿;
 * percent → value% × price paid. Never negative.
 */
function unitCredit(pricePaid: number, rule: TicketCreditRule): number {
  switch (rule.basis) {
    case 'full_price':
      return Math.max(0, pricePaid);
    case 'fixed':
      return Math.max(0, rule.value ?? 0);
    case 'percent':
      return Math.max(0, pricePaid * ((rule.value ?? 0) / 100));
    default:
      return 0;
  }
}

/** Whether a ticket's credit rule pays out to a person of the given role. */
function creditApplies(rule: TicketCreditRule | undefined, role: 'adult' | 'kid'): boolean {
  if (!rule || rule.appliesTo === 'none') return false;
  if (rule.appliesTo === 'both') return true;
  return role === 'adult' ? rule.appliesTo === 'adults' : rule.appliesTo === 'kids';
}

export interface PersonGrant {
  role: 'adult' | 'kid';
  creditTHB: number; // 0 when this person earns no credit
  gateAccess: boolean; // adults on a gate-access ticket; kids never
}

/**
 * One entry per PERSON (adults then kids, per line) across the sale's regular
 * play lines — promo and drop-off lines are skipped (drop-off children get their
 * band at door check-in). Each person's credit and gate access are read purely
 * from that line's own ticket package, so this is the single source that drives
 * BOTH the credit grants and the wristband minting. Adults are ordered paid-first
 * then free (mirrors computeLineBreakdown) so wallet indices stay stable.
 */
export function buildPersonGrants(lines: CartLine[]): PersonGrant[] {
  const out: PersonGrant[] = [];
  for (const line of lines) {
    if (line.promoItem || line.dropOff) continue;
    const rule = line.ticketType.creditRule;
    const gate = line.ticketType.gateAccess ?? false;
    const kidPrice = priceForTier(line.ticketType, line.tier);
    const adultLine = resolveAdultLine(line.ticketType, line.tier, line.adults);
    const adultPrices = [
      ...Array(adultLine.paidCount).fill(adultLine.paidUnit),
      ...Array(adultLine.freeCount).fill(0),
    ];
    for (const paid of adultPrices) {
      out.push({
        role: 'adult',
        gateAccess: gate,
        creditTHB: creditApplies(rule, 'adult') ? unitCredit(paid, rule!) : 0,
      });
    }
    for (let i = 0; i < line.kids; i++) {
      out.push({
        role: 'kid',
        gateAccess: false,
        creditTHB: creditApplies(rule, 'kid') ? unitCredit(kidPrice, rule!) : 0,
      });
    }
  }
  return out;
}

export function buildCreditGrants(lines: CartLine[], discounts: Discount[] = []): CreditGrant[] {
  const grants: CreditGrant[] = [];

  // One universal wallet credit per person who earns it (adults and/or kids per
  // the ticket's credit rule), spendable at BOTH the F&B and merch stations.
  // Emitted first (before item grants) and in person order so the wallet-minting
  // loops can index them positionally. role/gateAccess ride along so each minted
  // wallet doubles as that person's gate band with the right access.
  for (const p of buildPersonGrants(lines)) {
    if (p.creditTHB <= 0) continue;
    grants.push({
      id: `v-${Math.random().toString(36).substring(7)}`,
      type: 'fnb_credit',
      label: 'Credit',
      valueTHB: p.creditTHB,
      role: p.role,
      gateAccess: p.gateAccess,
    });
  }

  // Item credit grants for socks + add-ons, aggregated by label.
  const itemCounts: Record<string, number> = {};
  lines.forEach((line) => {
    if (line.socks > 0) {
      itemCounts['Regular Socks'] = (itemCounts['Regular Socks'] || 0) + line.socks;
    }
    line.addOns.forEach((a) => {
      itemCounts[a.name] = (itemCounts[a.name] || 0) + a.quantity;
    });
  });
  Object.entries(itemCounts).forEach(([label, quantity]) => {
    grants.push({
      id: `v-${Math.random().toString(36).substring(7)}`,
      type: 'item',
      label,
      quantity,
    });
  });

  // Free-item promos → mint a physical item grant per code so staff can
  // dispense each at the F&B counter. Labelled so it prints/displays distinctly.
  for (const discount of discounts) {
    if (discount.type === 'free_item' && discount.freeItemId) {
      const resolved = resolveFreeItem(discount);
      grants.push({
        id: `v-${Math.random().toString(36).substring(7)}`,
        type: 'item',
        label: resolved ? `Free: ${resolved.name}` : 'Free item (promo)',
        quantity: 1,
      });
    }
  }

  return grants;
}

interface BuildSaleParams {
  id?: string;
  operatorId: string;
  operatorName: string;
  tier: CustomerTier;
  lines: CartLine[];
  discounts?: Discount[];
  manualDiscounts?: ManualDiscount[];
  memberId?: string;
  customerPhone?: string;
  customerNickname?: string;
  /** The wristband this sale issued/associated (links it to per-client history). */
  wristbandCode?: string;
  paymentMethod?: string;
  /** Set when this sale came from redeeming an online booking (its reference). */
  bookingReference?: string;
  /** Provide stable credit grants (e.g. once finalized) instead of regenerating ids. */
  creditGrants?: CreditGrant[];
  /** Provide a stable timestamp (e.g. seeded history) instead of "now". */
  createdAt?: string;
  /**
   * WHAT THE PLATFORM QUOTED FOR THIS CART — S2-09a (SCRUM-203).
   *
   * Given, the sale carries these figures and is never re-totalled: the
   * confirmation screen, the receipt lines and the history detail all read
   * them, so the amount taken, the amount printed and the amount in the ledger
   * are one number. Omitted — a preview, a seeded sale, a screen that has no
   * quote — the sale is totalled from its lines by the engine (`ticketTotals`,
   * SCRUM-271), where the prototype's own arithmetic used to answer.
   */
  quoted?: SaleQuotedPricing;
}

export function buildSale(params: BuildSaleParams): Sale {
  const { operatorId, operatorName, tier, lines, memberId, customerPhone, customerNickname, wristbandCode, paymentMethod, bookingReference } = params;
  const discounts = params.discounts ?? [];
  const manualDiscounts = params.manualDiscounts ?? [];
  const total = params.quoted ? params.quoted.total : ticketTotals(lines, discounts, manualDiscounts).total;
  const totalKids = lines.reduce((acc, l) => acc + l.kids, 0);
  const totalAdults = lines.reduce((acc, l) => acc + l.adults, 0);

  return {
    ...(params.quoted ? { quoted: params.quoted } : {}),
    id: params.id ?? Math.random().toString(36).substring(2, 8).toUpperCase(),
    operatorId,
    operatorName,
    tier,
    lines,
    discounts,
    manualDiscounts,
    memberId,
    customerPhone,
    customerNickname,
    wristbandCode,
    paymentMethod,
    bookingReference,
    total,
    creditGrants: params.creditGrants ?? buildCreditGrants(lines, discounts),
    bracelets: {
      children: totalKids,
      adults: totalAdults,
    },
    createdAt: params.createdAt ?? new Date().toISOString(),
    status: 'paid',
    refunds: [],
  };
}
