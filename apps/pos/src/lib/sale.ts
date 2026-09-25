import {
  CartLine,
  CustomerTier,
  Discount,
  ManualDiscount,
  Sale,
  SaleQuotedPricing,
  TaxConfig,
  TaxableCategory,
  TicketCreditRule,
  CreditGrant,
} from '@/types';
import { computeManualDiscount } from '@/lib/manualDiscount';
import { computeLineBreakdown, lineComponentBases, priceForTier, resolveAdultLine } from '@/lib/pricing';
import { discountTargetBase } from '@/lib/discountTarget';
import { computeTaxBreakdown, groupTaxInputs, TaxCategoryInput } from '@/lib/tax';
import { getTaxConfig } from '@/store/catalogStore';
import { resolveFreeItem } from '@/lib/promoVoucher';

/**
 * Map a till cart's line components to taxable-category bases. Reuses
 * computeLineBreakdown so the bases always sum to the line totals:
 *   kids/adults → tickets, the drop-off service fee → drop_off, socks + add-ons → addons.
 *   prepaid food credit → drop_off (stored-value load; inclusive VAT reported, not added)
 *   prepaid food items  → fnb (taxed at the F&B rate, which is inclusive in the seeded config)
 */
export function tillTaxInputs(lines: CartLine[]): TaxCategoryInput[] {
  const inputs: TaxCategoryInput[] = [];
  for (const line of lines) {
    for (const item of computeLineBreakdown(line)) {
      // For individual add-on items, respect any taxCategoryOverride set on
      // the add-on (visible in Admin → Add-ons). Falls back to 'addons' when
      // absent. Socks ('socks' kind) and other non-addon kinds also default to
      // 'addons' — they have no per-item override path today.
      const addonCategory = (): TaxableCategory => {
        const a = line.addOns.find((ao) => ao.id === item.key);
        return a?.taxCategoryOverride ?? 'addons';
      };
      const category: TaxableCategory =
        item.key === 'dropoff-service'
          ? 'drop_off'
          : item.kind === 'kids' || item.kind === 'adults'
            ? 'tickets'
            : item.kind === 'addon'
              ? addonCategory()
              : 'addons'; // socks + any future non-addon kinds default here
      inputs.push({ category, base: item.subtotal });
    }
    // Prepaid food provision adds to lineTotal but isn't covered by
    // computeLineBreakdown — route it to the appropriate category so
    // the tax engine's grandTotal equals the sum of line totals.
    const fp = line.dropOff?.foodProvision;
    if (fp && fp.paidTHB > 0) {
      const category: TaxableCategory =
        fp.mode === 'prepaid_items'
          ? 'fnb'           // taxed NOW at the F&B category rate
          : 'stored_value'; // prepaid_credit: stored-value load, NOT taxed at load;
                            // tax is realized on spend at the F&B station
      inputs.push({ category, base: fp.paidTHB });
    }
  }
  return groupTaxInputs(inputs);
}

/** Per-code contribution of a scanned promo to the order's discount total. */
export interface ScannedDiscountLine {
  code: string;
  label: string;
  type: Discount['type'];
  amount: number;
}

export function computeTotals(
  lines: CartLine[],
  discounts: Discount[] = [],
  manualDiscounts: ManualDiscount[] = [],
  config: TaxConfig = getTaxConfig()
) {
  const subtotal = lines.reduce((acc, line) => acc + line.lineTotal, 0);

  const lineAmounts = Object.fromEntries(lines.map((l) => [l.id, l.lineTotal]));
  const componentBases = Object.fromEntries(
    lines.map((l) => [l.id, lineComponentBases(l)])
  );
  const manual = computeManualDiscount(manualDiscounts, subtotal, lineAmounts, componentBases);

  // Manual discounts come off first; scanned codes apply to what remains.
  // Multiple stackable codes apply SEQUENTIALLY: each subsequent code is
  // computed against the balance left by the previous one, so the order can
  // never go negative and a single code behaves exactly as before.
  let running = subtotal - manual.total;
  let discountAmount = 0;
  const scannedDiscounts: ScannedDiscountLine[] = [];
  for (const discount of discounts) {
    // The code applies only to the ฿ within its scope (whole order by default),
    // never more than what remains after earlier discounts.
    // For free_item promos the promoItem CartLine is already in `lines` at its
    // full shelf price.  Using `running` (the running total inclusive of the
    // item) as the base guarantees its amount = item.priceTHB exactly, so the
    // customer's bill stays unchanged while EOD records the markdown.
    const target = discount.target ?? { kind: 'everything' as const };
    const base =
      discount.type === 'free_item' || target.kind === 'everything'
        ? running
        : Math.min(discountTargetBase(lines, target), running);
    let amount =
      discount.type === 'fixed' || discount.type === 'free_item'
        ? Math.min(discount.value, base)
        : base * (discount.value / 100);
    amount = Math.min(amount, running);
    discountAmount += amount;
    running -= amount;
    scannedDiscounts.push({
      code: discount.code,
      label: discount.label,
      type: discount.type,
      amount,
    });
  }

  // Route the net through the tax + service engine. The engine's grand total
  // drives the order summary, customer display, receipt, refunds and end-of-day.
  // With the seeded config (inclusive VAT, no service) the grand total equals the
  // old subtotal − discount, so existing totals are unchanged; VAT is reported.
  const discountTotal = manual.total + discountAmount;
  const taxBreakdown = computeTaxBreakdown(tillTaxInputs(lines), discountTotal, config);

  return {
    subtotal,
    discountAmount,
    scannedDiscounts,
    manualDiscountAmount: manual.total,
    manualAmounts: manual.amounts,
    serviceChargeTotal: taxBreakdown.serviceChargeTotal,
    taxTotal: taxBreakdown.taxTotal,
    taxBreakdown,
    total: taxBreakdown.grandTotal,
  };
}

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
   * quote — the prototype's own arithmetic still answers, as it always did.
   */
  quoted?: SaleQuotedPricing;
}

export function buildSale(params: BuildSaleParams): Sale {
  const { operatorId, operatorName, tier, lines, memberId, customerPhone, customerNickname, wristbandCode, paymentMethod, bookingReference } = params;
  const discounts = params.discounts ?? [];
  const manualDiscounts = params.manualDiscounts ?? [];
  const total = params.quoted ? params.quoted.total : computeTotals(lines, discounts, manualDiscounts).total;
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
