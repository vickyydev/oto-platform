import type { RateMode } from './pricing-mode';
import { resolveRate } from './pricing-mode';
import type { Satang, WWPrice } from './money';
import type { TaxableCategory, TierAdultRuleShape } from './catalog-shapes';

/**
 * Ticket pricing — a faithful port of the prototype's `lib/pricing.ts`
 * (priceForTier / resolveAdultLine / computeLineTotal / computeLineBreakdown /
 * lineComponentBases), pure and in satang. The rules are approved behaviour:
 *   - kid price: the package's per-tier {weekday, weekend} pair; a tier with
 *     no entry is "not priced" and resolves to 0 (defensive, as in the
 *     prototype).
 *   - adults per tier: same_as_kid (default when absent) | set_price |
 *     free_adults (first N free PER LINE, overflow at kid price or the set price).
 *   - a line is kids + adults + socks + add-ons + any service fee.
 */
export interface PackagePricingShape {
  prices: Record<string, WWPrice>;
  adultRules?: Record<string, TierAdultRuleShape> | null;
}

export function priceForTier(pkg: PackagePricingShape, tier: string, mode: RateMode): Satang {
  return resolveRate(pkg.prices[tier], mode);
}

export interface ResolvedAdultLine {
  freeCount: number;
  paidCount: number;
  paidUnit: Satang;
  total: Satang;
}

/** Port of prototype `resolveAdultLine` (lib/pricing.ts:42) — free count is per LINE. */
export function resolveAdultLine(
  pkg: PackagePricingShape,
  tier: string,
  adults: number,
  mode: RateMode,
): ResolvedAdultLine {
  const kidPrice = priceForTier(pkg, tier, mode);
  const rule = pkg.adultRules?.[tier];
  if (!rule || rule.kind === 'same_as_kid') {
    return { freeCount: 0, paidCount: adults, paidUnit: kidPrice, total: adults * kidPrice };
  }
  if (rule.kind === 'set_price') {
    const unit = resolveRate(rule.price, mode);
    return { freeCount: 0, paidCount: adults, paidUnit: unit, total: adults * unit };
  }
  // free_adults
  const freeCount = Math.min(adults, Math.max(0, rule.freeAdults ?? 0));
  const paidCount = adults - freeCount;
  const paidUnit = rule.overflow === 'set_price' ? resolveRate(rule.price, mode) : kidPrice;
  return { freeCount, paidCount, paidUnit, total: paidCount * paidUnit };
}

export interface TicketLineInput {
  pkg: PackagePricingShape;
  tier: string;
  kids: number;
  adults: number;
}

export interface TicketLineBreakdown {
  kidUnit: Satang;
  kidsTotal: Satang;
  adults: ResolvedAdultLine;
  lineTotal: Satang;
}

/**
 * Kids + adults only. Kept for the public booking quote (SCRUM-36), which sells
 * admission with no extras; a till line goes through `priceCartLine`, which is
 * the pricing authority for anything in a ticket cart.
 */
export function computeTicketLine(input: TicketLineInput, mode: RateMode): TicketLineBreakdown {
  const kidUnit = priceForTier(input.pkg, input.tier, mode);
  const kidsTotal = input.kids * kidUnit;
  const adults = resolveAdultLine(input.pkg, input.tier, input.adults, mode);
  return { kidUnit, kidsTotal, adults, lineTotal: kidsTotal + adults.total };
}

// --- Cart lines -------------------------------------------------------------

/**
 * An add-on placed on a line. `price` is a SNAPSHOT: the catalogue's
 * weekday/weekend pair already resolved at the rate mode active when staff
 * added it, so a cart open across a mode change cannot mix rates for add-ons
 * (prototype `types.ts:244`, `lib/pricing.ts:82`). Socks are the deliberate
 * exception — see PricingContext.
 */
export interface CartAddOn {
  id: string;
  name: string;
  price: Satang;
  quantity: number;
  /** Set when staff split a stocked add-on across sizes; quantity is the sum. */
  variantBreakdown?: { variantId: string; variantLabel: string; quantity: number }[];
  /**
   * Points this add-on at a DIFFERENT taxable category. It never overrides a
   * rate — the rate always comes from that category's rule (prototype
   * `types.ts:221`). Absent = the `addons` category.
   */
  taxCategoryOverride?: TaxableCategory;
  /**
   * SCRUM-344 — SET WHEN THIS ROW IS AN F&B OR SHOP ITEM, not a ticket add-on.
   *
   * An F&B or shop line reaches the engine as one priced quantity of one
   * catalogue item on its own cart line, which is exactly what a `CartAddOn` is
   * (`resolveItemLines` in `apps/api/src/services/sale.ts` says why). The shape
   * fits; the MEANING does not, and the discount scopes are where that showed:
   * every such row answered `true` to the `addOns` scope and `false` to `fnb`,
   * `fnbCategory`, `menuItems` and `merch`, so a code scoped to food found no
   * base and a code scoped to add-ons reached the food.
   *
   * These two fields are what tells the two apart. Absent = a ticket add-on,
   * which is what every row carried before this ticket, so nothing about a
   * ticket cart changes.
   */
  itemKind?: 'menu' | 'merch';
  /**
   * The item's own menu category AND its parent, in that order — the walk an
   * `fnbCategory` scope matches on.
   *
   * Both levels, because scoping a code to a top-level category covers its
   * sub-categories: the prototype's `menuItemMatchesTarget` answers `true` when
   * the item's category IS the target or when its parent is
   * (`apps/pos/src/lib/discountTarget.ts:88-92`), and the seeded Iced Latte is
   * filed under Coffee, a sub-category of Drinks. Two levels is the whole tree
   * (`types.ts:717-729`), so this is never longer than two ids.
   */
  categoryIds?: readonly string[];
}

/**
 * Everything the engine needs about the branch catalogue to price a line.
 *
 * Socks are here rather than in `addOns` because the prototype keeps them as a
 * separate integer on the line (`CartLine.socks`) with a hard-coded add-on id
 * `'a-socks'` literal in eight files, re-read from the live catalogue on every
 * call and NOT snapshotted (`lib/pricing.ts:10,158,232`). The behaviour is
 * preserved — the caller resolves the current socks price and passes it — but
 * the id is context, not a constant, because the platform's add-ons are UUIDs
 * and a branch is entitled to its own.
 */
export interface PricingContext {
  mode: RateMode;
  socks: {
    addOnId: string;
    price: Satang;
    /** The prototype's visible row label, "Regular Socks". */
    label: string;
  };
}

/** The price-bearing parts of a cart line. */
export interface LinePricingInput {
  package: PackagePricingShape;
  tier: string;
  kids: number;
  adults: number;
  socks: number;
  addOns: readonly CartAddOn[];
  /** Drop-off / nanny service fee, added on top of the ticket (S2-13 fills it). */
  serviceFee?: { label: string; amount: Satang } | null;
}

/**
 * A line in a ticket cart. `lineTotal` is stored on the line exactly as the
 * prototype stores it, because a promo line's total is its item's shelf price
 * and is never recomputed from participants.
 */
export interface TicketCartLine extends LinePricingInput {
  id: string;
  /** Identifies the package for `ticketType`-scoped discounts. */
  packageId: string;
  lineTotal: Satang;
  /**
   * Present only on the synthetic line a `free_item` promo injects, at the
   * item's shelf price, id `promo-<CODE>` (prototype `pages/Till.tsx:580-587`).
   */
  promoItem?: { itemId: string; itemKind: 'menu' | 'merch'; name: string; price: Satang };
  /**
   * Prepaid food on a drop-off line. Carried by the port because it changes
   * which taxable category the money lands in (prototype `lib/sale.ts:52-60`);
   * no drop-off logic lives here (S2-13). It IS part of the line total — see
   * `priceCartLine`.
   */
  foodProvision?: { mode: 'prepaid_items' | 'prepaid_credit'; paid: Satang };
}

/**
 * Port of prototype `computeLineTotal` (lib/pricing.ts:148) — and, like the
 * prototype's, it prices PARTICIPANTS AND EXTRAS ONLY: kids, adults, socks,
 * add-ons, service fee. It does NOT know about prepaid food, exactly as the
 * prototype's does not; there the drop-off builder adds it on top
 * (`lib/dropoff.ts:87`, `lib/dropoff.ts:165`).
 *
 * This is not the function to call for a cart line. `priceCartLine` is.
 */
export function computeLineTotal(input: LinePricingInput, ctx: PricingContext): Satang {
  const kidPrice = priceForTier(input.package, input.tier, ctx.mode);
  const adultLine = resolveAdultLine(input.package, input.tier, input.adults, ctx.mode);

  let total = input.kids * kidPrice + adultLine.total;
  total += ctx.socks.price * input.socks;
  for (const addOn of input.addOns) total += addOn.price * addOn.quantity;
  total += input.serviceFee?.amount ?? 0;
  return total;
}

/**
 * THE LINE TOTAL FOR A CART LINE — the pricing authority for anything that goes
 * in a ticket cart, promo and drop-off lines included. A promo line carries its
 * item's shelf price and has no participants to price; every other line is
 * `computeLineTotal` PLUS any prepaid food.
 *
 * WHY THE FOOD IS HERE. The prototype keeps prepaid food out of
 * `computeLineTotal` and adds it in the drop-off builder, so its `lineTotal`
 * always includes it (`lib/dropoff.ts:87` builds `priceForTier + serviceFee +
 * food`; `lib/dropoff.ts:165` re-derives it as `computeLineTotal(...) + food`).
 * The port moved `foodProvision` onto the line itself, which made a trap: the
 * tax engine charges the food (`ticketCartTaxInputs` routes `foodProvision.paid`
 * to fnb or stored_value, per `lib/sale.ts:52-60`) while this function left it
 * out, so one drop-off line with ฿500 of prepaid credit priced a subtotal
 * ฿500 short of the bases the tax engine had already taxed.
 *
 * The prototype states the invariant that settles it at `lib/sale.ts:50-51`:
 * the food is routed to a category "so the tax engine's grandTotal equals the
 * sum of line totals". A line total that omits money the tax engine charges
 * breaks exactly that. So it is added here, and `computeLineTotal` stays a
 * faithful port of the function of the same name. A caller porting prototype
 * code must therefore NOT add the food a second time.
 */
export function priceCartLine(line: TicketCartLine, ctx: PricingContext): Satang {
  if (line.promoItem) return line.promoItem.price;
  return computeLineTotal(line, ctx) + (line.foodProvision?.paid ?? 0);
}

export type LineBreakdownKind = 'kids' | 'adults' | 'socks' | 'addon';

export interface LineBreakdownItem {
  key: string;
  kind: LineBreakdownKind;
  label: string;
  unitPrice: Satang;
  quantity: number;
  subtotal: Satang;
  /**
   * SCRUM-344 — copied from the add-on this row was rendered from, and present
   * only on an F&B or shop item row. See `CartAddOn.itemKind`; `rowMatchesTarget`
   * is what reads them.
   */
  itemKind?: 'menu' | 'merch';
  categoryIds?: readonly string[];
}

/** Compact size summary for a multi-variant add-on, e.g. "1×S, 2×M". */
export function addOnVariantSummary(
  breakdown: readonly { variantLabel: string; quantity: number }[],
): string {
  return breakdown.map((b) => `${b.quantity}×${b.variantLabel}`).join(', ');
}

/**
 * Itemised breakdown of a cart line, in the row order the display, the receipt
 * and the discount math all rely on: kids, adults (paid), adults (free), socks,
 * add-ons in cart order, service fee. Mirrors `computeLineTotal` exactly so the
 * rows sum to the line total. Port of prototype `computeLineBreakdown`
 * (lib/pricing.ts:188).
 */
export function computeLineBreakdown(
  line: TicketCartLine,
  ctx: PricingContext,
): LineBreakdownItem[] {
  // A promo line has no ticket components — its price is meant to be wholly
  // offset by the matching discount, so it contributes no component rows.
  // (This is also why its base never reaches the tax engine; see
  // ticketCartTaxInputs, where the consequence is recorded.)
  if (line.promoItem) return [];

  const kidPrice = priceForTier(line.package, line.tier, ctx.mode);
  const items: LineBreakdownItem[] = [];

  if (line.kids > 0) {
    items.push({
      key: 'kids',
      kind: 'kids',
      label: 'Kids',
      unitPrice: kidPrice,
      quantity: line.kids,
      subtotal: line.kids * kidPrice,
    });
  }
  if (line.adults > 0) {
    const adultLine = resolveAdultLine(line.package, line.tier, line.adults, ctx.mode);
    if (adultLine.paidCount > 0) {
      items.push({
        key: 'adults',
        kind: 'adults',
        label: 'Adults',
        unitPrice: adultLine.paidUnit,
        quantity: adultLine.paidCount,
        subtotal: adultLine.paidCount * adultLine.paidUnit,
      });
    }
    if (adultLine.freeCount > 0) {
      // Free adults get their own row at ฿0 so the guest can see they were
      // counted and not charged.
      items.push({
        key: 'adults-free',
        kind: 'adults',
        label: 'Adults (free)',
        unitPrice: 0,
        quantity: adultLine.freeCount,
        subtotal: 0,
      });
    }
  }
  if (line.socks > 0) {
    items.push({
      key: 'socks',
      kind: 'socks',
      label: ctx.socks.label,
      unitPrice: ctx.socks.price,
      quantity: line.socks,
      subtotal: line.socks * ctx.socks.price,
    });
  }
  for (const addOn of line.addOns) {
    const label =
      addOn.variantBreakdown && addOn.variantBreakdown.length > 0
        ? `${addOn.name} (${addOnVariantSummary(addOn.variantBreakdown)})`
        : addOn.name;
    items.push({
      key: addOn.id,
      kind: 'addon',
      label,
      unitPrice: addOn.price,
      quantity: addOn.quantity,
      subtotal: addOn.price * addOn.quantity,
      // Carried through so the discount scopes can tell an F&B or shop item
      // from a ticket add-on; absent on every ticket add-on (SCRUM-344).
      ...(addOn.itemKind ? { itemKind: addOn.itemKind } : {}),
      ...(addOn.categoryIds ? { categoryIds: addOn.categoryIds } : {}),
    });
  }
  // The service-fee row reuses the 'addon' kind so icon maps stay exhaustive,
  // and comes last so the rows sum to the line total.
  if (line.serviceFee && line.serviceFee.amount > 0) {
    items.push({
      key: SERVICE_FEE_ROW_KEY,
      kind: 'addon',
      label: line.serviceFee.label,
      unitPrice: line.serviceFee.amount,
      quantity: 1,
      subtotal: line.serviceFee.amount,
    });
  }

  return items;
}

/**
 * The breakdown key the drop-off / nanny service-fee row carries. It reuses the
 * 'addon' kind, so every place that means "a real add-on" has to exclude this
 * key by name — the prototype does the same (`lib/discountTarget.ts:41`).
 */
export const SERVICE_FEE_ROW_KEY = 'dropoff-service';

/** Which part of a line a component-scoped manual discount targets. */
export type DiscountComponentTarget =
  { kind: 'kids' } | { kind: 'adults' } | { kind: 'socks' } | { kind: 'addon'; addOnId: string };

/**
 * Stable key for a component target, shared by the discount math, the picker
 * and both displays. kids/adults/socks keep their kind; an add-on becomes
 * `addon:<id>`.
 */
export function componentKey(target: DiscountComponentTarget): string {
  return target.kind === 'addon' ? `addon:${target.addOnId}` : target.kind;
}

/** The same key derived from a rendered breakdown row. */
export function breakdownComponentKey(item: LineBreakdownItem): string {
  return item.kind === 'addon' ? `addon:${item.key}` : item.kind;
}

/**
 * The satang base of each discountable component of a line, keyed by
 * componentKey. Paid and free adults collapse into one `adults` base, because
 * both rows carry the `adults` kind. Port of prototype `lineComponentBases`.
 */
export function lineComponentBases(
  line: TicketCartLine,
  ctx: PricingContext,
): Record<string, Satang> {
  const bases: Record<string, Satang> = {};
  for (const item of computeLineBreakdown(line, ctx)) {
    const key = breakdownComponentKey(item);
    bases[key] = (bases[key] ?? 0) + item.subtotal;
  }
  return bases;
}
