import type { Satang } from './money';
import type {
  CategoryTaxRuleShape,
  TaxConfigShape,
  TaxMode,
  TaxableCategory,
} from './catalog-shapes';
import { apportion, roundHalfUpSatang } from './rounding';

/**
 * The VAT + service-charge cascade — a faithful port of the prototype's
 * `lib/tax.ts` (`computeTaxBreakdown`, `summarizeTax`, `groupTaxInputs`), in
 * satang. Pure: it takes the base per taxable category, the already-resolved
 * discount and the config, and returns a breakdown. Callers pass the config in
 * (they always did) so a live cart and a report re-deriving a year-old sale run
 * the same code over that sale's own snapshot.
 *
 * Order of operations, unchanged from the prototype:
 *   1. base per category
 *   2. the discount, per `discountPlacement`:
 *        before_tax → a discount that targeted one category comes off that
 *                     category; an order-wide one is spread in proportion to
 *                     what is left of each base; THEN service and tax on what
 *                     remains. (The attribution step is the one place this
 *                     departs from the prototype's arithmetic, on the
 *                     prototype's own written instruction — see
 *                     `computeTaxBreakdown`.)
 *        after_tax  → service and tax on the FULL base, then the whole discount
 *                     comes off the grand gross
 *   3. service charge = base × serviceChargePercent, on the possibly-reduced base
 *   4. tax per rule: none → 0; exclusive → added on top of base [+ service when
 *      taxOnServiceCharge]; inclusive → already in the price, unwound for
 *      REPORTING only, the displayed price unchanged
 *   5. grand total
 *
 * Open decision 22 (inclusive-tax decomposition and rounding) was resolved on
 * 2026-09-20: "the prototype's `lib/tax.ts` order is the definition, captured
 * in regression fixtures; no accountant session; corrections later as data"
 * (SPRINT_2_PLAN.md). That is why this file ports the cascade as it stands
 * rather than reopening the order, and why there is no
 * inclusive-of-VAT-and-service mode: the prototype has none, and inventing its
 * decomposition order would be inventing money.
 */

/** One category's base going into the cascade, before any discount. */
export interface TaxCategoryInput {
  category: TaxableCategory;
  base: Satang;
}

/**
 * One discount, and WHAT IT WAS AIMED AT.
 *
 * A discount total on its own is not enough information to place it correctly
 * once categories can carry different tax rules — see the attribution note on
 * `computeTaxBreakdown`. `category` names the taxable category the discount
 * actually targeted; absent means it was aimed at the whole order and is spread
 * across categories in proportion to their bases, the prototype's arithmetic.
 *
 * A discount whose scope spans several categories (an `addOns`-scoped code over
 * an add-on that carries a `taxCategoryOverride`, or a whole-line discount on a
 * line holding tickets and a drop-off fee) is split by the caller into one
 * allocation per category before it reaches here; `cart-totals.ts` does that.
 */
export interface DiscountAllocation {
  amount: Satang;
  /** Absent = order-wide. */
  category?: TaxableCategory;
}

/** A plain satang total is read as one order-wide allocation. */
export type DiscountInput = Satang | readonly DiscountAllocation[];

function toAllocations(discount: DiscountInput): DiscountAllocation[] {
  if (typeof discount === 'number') return [{ amount: Math.max(0, discount) }];
  return discount.filter((entry) => entry.amount > 0).map((entry) => ({ ...entry }));
}

/** The computed tax and service for a single category. */
export interface CategoryTaxLine {
  category: TaxableCategory;
  /** Base after discount apportionment (before_tax), or the full base (after_tax). */
  base: Satang;
  taxMode: TaxMode;
  taxRateId?: string;
  taxName?: string;
  /** Whole percent, e.g. 7. */
  taxPercent: number;
  serviceCharge: Satang;
  /** Tax ADDED (exclusive) or INCLUDED and reported (inclusive); 0 for none. */
  tax: Satang;
  secondaryTaxRateId?: string;
  secondaryTaxName?: string;
  secondaryTaxMode: TaxMode;
  secondaryTaxPercent: number;
  secondaryTax: Satang;
  /** What the guest pays for this category, before any after_tax discount. */
  gross: Satang;
}

export interface TaxBreakdown {
  /** Sum of the original category bases — the "Subtotal" the receipt shows. */
  netSubtotal: Satang;
  discountTotal: Satang;
  serviceChargeTotal: Satang;
  /** Tax ADDED on top (exclusive rules only). */
  exclusiveTaxTotal: Satang;
  /** Tax already INSIDE the price, reported for the receipt (inclusive rules). */
  inclusiveTaxTotal: Satang;
  /**
   * exclusiveTaxTotal + inclusiveTaxTotal. Note this adds two different kinds
   * of money: tax the guest paid on top, and tax that was already in the price.
   * In a mixed-mode config it is not "what the guest paid in tax". The
   * prototype has the same shape (`lib/tax.ts:196`) and the receipt rows from
   * `summarizeTax` are what should be shown, not this number.
   */
  taxTotal: Satang;
  categories: CategoryTaxLine[];
  grandTotal: Satang;
  /**
   * Discount that found no base to reduce and was therefore dropped.
   *
   * ADDED HERE, not in the prototype. The prototype clamps with
   * `Math.max(0, base - share)` (`lib/tax.ts:109`) and the excess simply
   * vanishes with no signal.
   *
   * WHEN IT IS NON-ZERO, exactly — because a looser sentence here was wrong
   * and a fixture beside it disproved it. Under before_tax it is the discount
   * left over once every allocation has been applied to what it could reach:
   *   - an allocation naming a category this cart has no base in at all
   *     (fixture TX-ATTR-5), or more of one than that category holds;
   *   - a discount larger than the WHOLE cart's base, which is what a free-item
   *     promo line can cause: its total is in the subtotal but its base never
   *     reaches the engine, so a comp of the whole subtotal overruns the bases
   *     by the item's price (fixture EC-8).
   * A free-item promo line on its own does NOT produce one: its discount is
   * order-wide, order-wide allocations are apportioned across the bases that
   * remain, and on an ordinary cart another category simply absorbs it
   * (fixture WE-8, unappliedDiscount 0). Under after_tax it is the discount
   * that exceeds the grand gross.
   *
   * This makes the loss visible to whoever reconciles the day; a non-zero value
   * here on an ordinary sale means the cart's discounts have overrun the money
   * on the bill and the receipt should be read before it is handed over.
   */
  unappliedDiscount: Satang;
}

const DEFAULT_RULE = (category: TaxableCategory): CategoryTaxRuleShape => ({
  category,
  taxMode: 'none',
});

/**
 * Compute the full tax and service-charge breakdown for a set of category bases.
 *
 * `discount` is the already-resolved discount for the whole order (manual +
 * promo), either as a plain satang total or as `DiscountAllocation`s carrying
 * the category each part targeted. This places it before or after tax per the
 * config.
 *
 * HOW A BEFORE-TAX DISCOUNT IS PLACED, and why it is not simply spread.
 *
 * The prototype spreads the order's whole discount across the categories in
 * proportion to their bases. It carries an explicit warning immediately above
 * that arithmetic (`lib/tax.ts:99-106`) saying the spread is exact ONLY while
 * every category in the cart shares one tax rule — "which is the only state
 * reachable today", because nothing yet lets an owner set divergent rules — and
 * that "once divergent rules become configurable … a line/category-scoped
 * discount must instead be attributed to the category it actually targets,
 * since spreading it across differently-taxed categories would shift the grand
 * total". S2-09a is the ticket that makes those rules configurable, so this is
 * the moment the prototype's own comment names. The port had dropped the
 * warning; it is restored here, in force rather than as history.
 *
 * What it costs to get wrong, measured on real configurations and pinned as
 * fixtures TX-ATTR-1/2/3: a ฿200 discount scoped to tickets, alongside a
 * stored-value load of the same size, overstates reported VAT by 654 satang
 * when it is spread — a number that goes on a tax return. With mixed
 * inclusive and exclusive categories the spread moves what the GUEST PAYS,
 * because reducing an exclusive category's base also reduces the tax added on
 * top of it.
 *
 * So, before tax:
 *   1. Every allocation that NAMES a category comes off that category's base,
 *      in order, clamped to what is left of it.
 *   2. Whatever a named allocation could not absorb is DROPPED and reported in
 *      `unappliedDiscount` — it is not quietly spilled onto another category,
 *      which is the misattribution this exists to stop. TX-ATTR-5 pins it.
 *   3. Order-wide allocations are then apportioned across what REMAINS of each
 *      base, largest remainder, because a category already zeroed by a scoped
 *      comp cannot absorb more.
 *
 * Step 2 is a contract for a caller that hands this function allocations
 * DIRECTLY. A ticket cart never relies on it: `cart-totals.ts` attributes each
 * discount against the bases that remain after the earlier ones and turns any
 * surplus into an order-wide allocation before it gets here, so the guest's
 * total matches the prototype's on a config where the prototype's proportional
 * spread is exact. Read the attribution note there before changing either side.
 *
 * After tax, the placement is unchanged and attribution is meaningless: the
 * whole discount comes off the grand gross, so no category's base moves.
 *
 * PRECONDITION, AND WHY IT IS ENFORCED RATHER THAN DOCUMENTED. Step 1 has to
 * find the row a named allocation belongs to. Before attribution existed the
 * order of `inputs` could not change an answer; now two rows sharing a category
 * would let a named allocation reduce only the FIRST of them and report the
 * rest as unapplied — `[{tickets,50000},{tickets,50000}]` with a 80000
 * tickets-scoped discount came out as a total of 50000 where the prototype
 * gives 20000. `ticketCartTaxInputs` groups, so no cart reached it, but this
 * function is exported and S2-09b will call it directly. It therefore groups
 * its inputs itself (`groupTaxInputs`, first-seen order) instead of trusting a
 * caller to. The visible consequence: `categories` holds exactly one row per
 * category, which is what `summarizeTax` and every `.find(...)` on the result
 * already assume.
 */
export function computeTaxBreakdown(
  rawInputs: readonly TaxCategoryInput[],
  discount: DiscountInput,
  config: TaxConfigShape,
): TaxBreakdown {
  const ruleFor = (category: TaxableCategory): CategoryTaxRuleShape =>
    config.categoryRules.find((r) => r.category === category) ?? DEFAULT_RULE(category);
  const rateFor = (id?: string) => config.rates.find((r) => r.id === id);

  // One row per category, first-seen order — see the precondition note above.
  const inputs = groupTaxInputs(rawInputs);
  const totalBase = inputs.reduce((sum, input) => sum + input.base, 0);
  const before = config.discountPlacement === 'before_tax';
  const allocations = toAllocations(discount);
  const discountTotal = allocations.reduce((sum, entry) => sum + entry.amount, 0);

  // How much each category's base is reduced, and how much discount found no
  // base to land on. Both stay zero under after_tax placement.
  const reductions = inputs.map(() => 0);
  let unabsorbed = 0;

  if (before) {
    // 1 + 2. Scoped allocations, against the category each one named.
    let orderWide = 0;
    for (const entry of allocations) {
      if (entry.category === undefined) {
        orderWide += entry.amount;
        continue;
      }
      const index = inputs.findIndex((input) => input.category === entry.category);
      if (index === -1) {
        // The discount targeted a category with no base in this cart at all.
        unabsorbed += entry.amount;
        continue;
      }
      const remaining = (inputs[index]?.base ?? 0) - (reductions[index] ?? 0);
      const applied = Math.min(entry.amount, Math.max(0, remaining));
      reductions[index] = (reductions[index] ?? 0) + applied;
      unabsorbed += entry.amount - applied;
    }

    // 3. Order-wide, spread across what is left. The prototype spreads as a
    // float share (`discount * base/totalBase`), which sums back to the
    // discount exactly; in whole satang only a largest-remainder split keeps
    // that property.
    if (orderWide > 0) {
      const shares = apportion(
        orderWide,
        inputs.map((input, index) => Math.max(0, input.base - (reductions[index] ?? 0))),
      );
      let spread = 0;
      inputs.forEach((input, index) => {
        const remaining = Math.max(0, input.base - (reductions[index] ?? 0));
        const applied = Math.min(shares[index] ?? 0, remaining);
        reductions[index] = (reductions[index] ?? 0) + applied;
        spread += applied;
      });
      unabsorbed += orderWide - spread;
    }
  }

  const categories: CategoryTaxLine[] = inputs.map((input, index) => {
    const rule = ruleFor(input.category);
    const rate = rule.taxMode === 'none' ? undefined : rateFor(rule.taxRateId);
    const percent = rate?.percent ?? 0;
    const servicePercent = rule.serviceChargePercent ?? 0;

    const base = Math.max(0, input.base - (reductions[index] ?? 0));

    const serviceCharge = roundHalfUpSatang((base * servicePercent) / 100);
    const taxableAmount = base + (rule.taxOnServiceCharge ? serviceCharge : 0);

    let tax = 0;
    if (rule.taxMode === 'exclusive') {
      tax = roundHalfUpSatang((taxableAmount * percent) / 100);
    } else if (rule.taxMode === 'inclusive') {
      // The prototype writes this as `x − x/(1+r)`. `x × p/(100+p)` is the same
      // value rearranged, chosen because it keeps the numerator an exact
      // integer product instead of subtracting two near-equal floats, which can
      // shift the result across a half-satang boundary.
      tax = percent > 0 ? roundHalfUpSatang((taxableAmount * percent) / (100 + percent)) : 0;
    }

    // Secondary tax: a second rate on this category, carrying its own mode.
    //  - 'exclusive' (the default when a secondary rate is set): ADDED on top,
    //    on (base + service + any primary tax that sits ON TOP of the price).
    //    An inclusive primary is already inside `base` and is not added again,
    //    which is how "5 % on (price + VAT)" comes out.
    //  - 'inclusive': already inside the price, unwound from the SAME taxable
    //    amount as the primary, in parallel rather than in sequence. Two
    //    inclusive rates therefore each report an unwind from the full amount;
    //    the prototype's comment (`lib/tax.ts:126-129`) says this is deliberate
    //    so both can be broken out on a receipt, and the grand total is
    //    untouched either way.
    const secondaryRate = rateFor(rule.secondaryTaxRateId);
    const secondaryPercent = secondaryRate?.percent ?? 0;
    const secondaryMode: TaxMode = secondaryRate ? (rule.secondaryTaxMode ?? 'exclusive') : 'none';
    let secondaryTax = 0;
    if (secondaryMode === 'exclusive') {
      // Built on the ROUNDED primary tax: totals are sums of rounded components,
      // so the number the receipt shows is the number the secondary was charged on.
      const secondaryBase = base + serviceCharge + (rule.taxMode === 'exclusive' ? tax : 0);
      secondaryTax = roundHalfUpSatang((secondaryBase * secondaryPercent) / 100);
    } else if (secondaryMode === 'inclusive') {
      secondaryTax =
        secondaryPercent > 0
          ? roundHalfUpSatang((taxableAmount * secondaryPercent) / (100 + secondaryPercent))
          : 0;
    }

    // Exclusive tax is added on top; inclusive tax is already inside the price.
    // The service charge is ALWAYS additive — there is no mode in which it sits
    // inside the quoted price.
    const gross =
      base +
      serviceCharge +
      (rule.taxMode === 'exclusive' ? tax : 0) +
      (secondaryMode === 'exclusive' ? secondaryTax : 0);

    return {
      category: input.category,
      base,
      taxMode: rule.taxMode,
      taxRateId: rule.taxMode === 'none' ? undefined : rule.taxRateId,
      taxName: rate?.name,
      taxPercent: percent,
      serviceCharge,
      tax,
      secondaryTaxRateId: secondaryRate?.id,
      secondaryTaxName: secondaryRate?.name,
      secondaryTaxMode: secondaryMode,
      secondaryTaxPercent: secondaryPercent,
      secondaryTax,
      gross,
    };
  });

  const sumGross = categories.reduce((sum, c) => sum + c.gross, 0);
  const grandTotal = before ? sumGross : Math.max(0, sumGross - discountTotal);
  const unappliedDiscount = before ? unabsorbed : Math.max(0, discountTotal - sumGross);

  const exclusiveTaxTotal =
    categories.filter((c) => c.taxMode === 'exclusive').reduce((sum, c) => sum + c.tax, 0) +
    categories
      .filter((c) => c.secondaryTaxMode === 'exclusive')
      .reduce((sum, c) => sum + c.secondaryTax, 0);
  const inclusiveTaxTotal =
    categories.filter((c) => c.taxMode === 'inclusive').reduce((sum, c) => sum + c.tax, 0) +
    categories
      .filter((c) => c.secondaryTaxMode === 'inclusive')
      .reduce((sum, c) => sum + c.secondaryTax, 0);

  return {
    netSubtotal: totalBase,
    discountTotal,
    serviceChargeTotal: categories.reduce((sum, c) => sum + c.serviceCharge, 0),
    exclusiveTaxTotal,
    inclusiveTaxTotal,
    taxTotal: exclusiveTaxTotal + inclusiveTaxTotal,
    categories,
    grandTotal,
    unappliedDiscount,
  };
}

/**
 * A display row for a receipt or order summary: a service charge, an included
 * (reported) tax, or an added tax. Inclusive rows are informational — already
 * in the total; added rows are part of it.
 */
export interface TaxSummaryRow {
  key: string;
  /** e.g. "Service charge", "VAT included", "VAT". */
  label: string;
  amount: Satang;
  kind: 'service' | 'tax_included' | 'tax_added';
}

/**
 * Reduce a breakdown to the rows a receipt should show: the service charge
 * first when there is one, then one row per (mode, tax name). Zero amounts are
 * skipped. Port of the prototype's `summarizeTax` (`lib/tax.ts:217`).
 */
export function summarizeTax(breakdown: TaxBreakdown): TaxSummaryRow[] {
  const rows: TaxSummaryRow[] = [];
  if (breakdown.serviceChargeTotal > 0) {
    rows.push({
      key: 'service',
      label: 'Service charge',
      amount: breakdown.serviceChargeTotal,
      kind: 'service',
    });
  }

  const byKey = new Map<string, { name: string; mode: TaxMode; amount: Satang }>();
  for (const category of breakdown.categories) {
    if (category.tax > 0 && category.taxMode !== 'none') {
      const name = category.taxName ?? 'Tax';
      const key = `${category.taxMode}:${name}`;
      const current = byKey.get(key) ?? { name, mode: category.taxMode, amount: 0 };
      current.amount += category.tax;
      byKey.set(key, current);
    }
    if (category.secondaryTax > 0 && category.secondaryTaxMode !== 'none') {
      const name = category.secondaryTaxName ?? 'Tax';
      const key = `${category.secondaryTaxMode}:${name}`;
      const current = byKey.get(key) ?? { name, mode: category.secondaryTaxMode, amount: 0 };
      current.amount += category.secondaryTax;
      byKey.set(key, current);
    }
  }
  for (const [key, value] of byKey) {
    rows.push({
      key,
      label: value.mode === 'inclusive' ? `${value.name} included` : value.name,
      amount: value.amount,
      kind: value.mode === 'inclusive' ? 'tax_included' : 'tax_added',
    });
  }
  return rows;
}

/** Sum inputs that share a category into one entry each, in first-seen order. */
export function groupTaxInputs(inputs: readonly TaxCategoryInput[]): TaxCategoryInput[] {
  const byCategory = new Map<TaxableCategory, Satang>();
  for (const input of inputs) {
    byCategory.set(input.category, (byCategory.get(input.category) ?? 0) + input.base);
  }
  return [...byCategory.entries()].map(([category, base]) => ({ category, base }));
}
