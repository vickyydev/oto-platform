import {
  CartLine,
  CustomerTier,
  Discount,
  ManualDiscount,
  Sale,
  SaleQuotedPricing,
  CreditGrant,
} from '@/types';
import { grantLinesOfCart, personGrantsOf } from '@oto/shared';
import { resolveFreeItem } from '@/lib/promoVoucher';
import { engineCartLine, pricingContext, ticketTotals } from '@/lib/cartWire';

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

export interface PersonGrant {
  role: 'adult' | 'kid';
  creditTHB: number; // 0 when this person earns no credit
  gateAccess: boolean; // adults on a gate-access ticket; kids never
}

/**
 * One entry per PERSON (adults then kids, per line) across the sale's regular
 * play lines — promo and drop-off lines are skipped (drop-off children get their
 * band at door check-in). This is the single source that drives BOTH the credit
 * grants and the wristband minting. Adults are ordered paid-first then free
 * (mirrors computeLineBreakdown) so wallet indices stay stable.
 *
 * SCRUM-883 — WHO EARNS WHAT IS THE PLATFORM'S GRANT LAW, NOT A SECOND COPY OF
 * IT. The prototype read each person's credit from the adult rule alone
 * (`unitCredit` / `creditApplies` here), which knew nothing of the free items
 * a rate bundles (SCRUM-768): on staging a Thai adult the rate let in free was
 * counted as paying ฿350 and earning ฿350, and the customer's thank-you showed
 * a credit the platform never granted. Each person's credit is now read from
 * the rows the platform files for this cart (`grantLinesOfCart` in
 * `@oto/shared`, the same `cartUnits` and `grantLinesOfLedger` that
 * `grantSaleCredit` reads), so the till promises what the platform grants:
 * a free adult (by the adult rule or the free items) earns nothing under
 * `full_price` or `percent` and the rule's value under `fixed`; a child the
 * free items let in earns nothing; SCRUM-798's Golden Ticket child and parent
 * earn nothing. Every person still has an entry, for their band.
 */
export function buildPersonGrants(lines: CartLine[]): PersonGrant[] {
  const play = lines.filter((line) => !line.promoItem && !line.dropOff);
  if (play.length === 0) return [];
  const packages = new Map(
    play.map((line) => [
      line.ticketType.id,
      { creditRule: line.ticketType.creditRule ?? null, gateAccess: line.ticketType.gateAccess ?? false },
    ]),
  );
  const gifts = new Set(play.filter((line) => line.voucherGift).map((line) => line.id));
  const earned = new Map<string, number>();
  for (const person of personGrantsOf(grantLinesOfCart(play.map(engineCartLine), pricingContext(), packages, new Set(), gifts))) {
    earned.set(`${person.cartLineId}:${person.role}:${person.ordinal}`, person.creditSatang);
  }
  const creditOf = (lineId: string, role: 'adult' | 'kid', ordinal: number): number =>
    (earned.get(`${lineId}:${role}:${ordinal}`) ?? 0) / 100;
  const out: PersonGrant[] = [];
  for (const line of play) {
    const gate = line.ticketType.gateAccess ?? false;
    for (let ordinal = 0; ordinal < line.adults; ordinal++) {
      out.push({ role: 'adult', gateAccess: gate, creditTHB: creditOf(line.id, 'adult', ordinal) });
    }
    for (let ordinal = 0; ordinal < line.kids; ordinal++) {
      out.push({ role: 'kid', gateAccess: false, creditTHB: creditOf(line.id, 'kid', ordinal) });
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
