import { CategoryTaxRule, TaxConfig, TaxMode, TaxableCategory } from '@/types';

// The configurable tax + service-charge engine. PURE: it takes the net base per
// category, the total discount, and the config, and returns a full breakdown. It
// never reads the store — callers (lib/sale.ts, lib/fnb.ts) pass the config in so
// historical recompute and live carts share one source of truth.
//
// Order of operations (per the owner's-accountant spec):
//   1. net/base per category
//   2. discounts per `discountPlacement`:
//        before_tax → reduce each category's base (apportioned by share), THEN
//                     service + tax on the reduced base
//        after_tax  → service + tax on the FULL base, then reduce the grand gross
//   3. service charge = base * serviceChargePercent (on the possibly-reduced base)
//   4. tax per rule: none → 0; exclusive → added on top of (base [+ service if
//      taxOnServiceCharge]); inclusive → already in the price, back-calculated
//      (gross − gross/(1+rate)) for REPORTING only (displayed price unchanged)
//   5. grand total

// One category's net base going into the engine. `base` is the sum of the line /
// component amounts that belong to this taxable area (already net of nothing —
// the engine applies discounts).
export interface TaxCategoryInput {
  category: TaxableCategory;
  base: number;
}

// The computed tax + service for a single category.
export interface CategoryTaxLine {
  category: TaxableCategory;
  /** Base after discount apportionment (before_tax) or the full base (after_tax). */
  base: number;
  taxMode: TaxMode;
  taxRateId?: string;
  taxName?: string;
  taxPercent: number; // whole number, e.g. 7
  serviceCharge: number;
  /** Tax ADDED (exclusive) or INCLUDED & reported (inclusive); 0 for none. */
  tax: number;
  // Optional second tax on this category. It carries its own mode:
  //  - 'exclusive': ADDED on top, computed on (base + service + the primary tax
  //    that's in the price).
  //  - 'inclusive': already inside the price, extracted for REPORTING only.
  // All zero/'none' when no secondary rate is configured.
  secondaryTaxRateId?: string;
  secondaryTaxName?: string;
  secondaryTaxMode: TaxMode;
  secondaryTaxPercent: number;
  secondaryTax: number;
  /** What the customer pays for this category (before any after_tax discount). */
  gross: number;
}

export interface TaxBreakdown {
  /** Sum of the original category bases — the "Subtotal" shown today. */
  netSubtotal: number;
  discountTotal: number;
  serviceChargeTotal: number;
  /** Tax that is ADDED on top (exclusive rules only). */
  exclusiveTaxTotal: number;
  /** Tax already INSIDE the price, reported for the receipt (inclusive rules). */
  inclusiveTaxTotal: number;
  /** exclusiveTaxTotal + inclusiveTaxTotal. */
  taxTotal: number;
  categories: CategoryTaxLine[];
  grandTotal: number;
}

const DEFAULT_RULE = (category: TaxableCategory): CategoryTaxRule => ({
  category,
  taxMode: 'none',
});

/**
 * Compute the full tax + service-charge breakdown for a set of category bases.
 * `discountTotal` is the already-resolved ฿ discount for the whole order (promo +
 * manual); the engine places it before or after tax per `config.discountPlacement`.
 */
export function computeTaxBreakdown(
  inputs: TaxCategoryInput[],
  discountTotal: number,
  config: TaxConfig,
): TaxBreakdown {
  const ruleFor = (cat: TaxableCategory): CategoryTaxRule =>
    config.categoryRules.find((r) => r.category === cat) ?? DEFAULT_RULE(cat);

  const rateFor = (id?: string) => config.rates.find((r) => r.id === id);

  const totalBase = inputs.reduce((sum, i) => sum + i.base, 0);
  const before = config.discountPlacement === 'before_tax';
  const discount = Math.max(0, discountTotal);

  const categories: CategoryTaxLine[] = inputs.map((input) => {
    const rule = ruleFor(input.category);
    const rate = rule.taxMode === 'none' ? undefined : rateFor(rule.taxRateId);
    const pct = rate ? rate.percent / 100 : 0;
    const scPct = (rule.serviceChargePercent ?? 0) / 100;

    // before_tax: each category absorbs a share of the discount proportional to
    // its base. This is EXACT whenever the categories in this cart share the same
    // tax rule (the seeded config makes every category identical), which is the
    // only state reachable today — there is no UI yet to set divergent per-category
    // rules. Once divergent rules become configurable (the admin-editing prompt),
    // a line/category-scoped discount must instead be attributed to the category
    // it actually targets, since spreading it across differently-taxed categories
    // would shift the grand total. See memory: tax-engine discount attribution.
    const discountShare =
      before && totalBase > 0 ? discount * (input.base / totalBase) : 0;
    const base = Math.max(0, input.base - discountShare);

    const serviceCharge = base * scPct;
    const taxableAmount = base + (rule.taxOnServiceCharge ? serviceCharge : 0);

    let tax = 0;
    if (rule.taxMode === 'exclusive') {
      tax = taxableAmount * pct;
    } else if (rule.taxMode === 'inclusive') {
      tax = pct > 0 ? taxableAmount - taxableAmount / (1 + pct) : 0;
    }

    // Secondary tax: a second rate on this area, carrying its own mode.
    //  - 'exclusive' (default): ADDED on top. Its base is the price the customer
    //    sees so far plus any primary tax that sits ON TOP of that price — i.e.
    //    the exclusive primary tax. Inclusive primary tax is already inside
    //    `base`, so it isn't added again. This yields "5% on (price + VAT)".
    //  - 'inclusive': already inside the price, extracted from the taxable amount
    //    for REPORTING only (parallel to an inclusive primary). It does NOT change
    //    what the customer pays, so two inclusive taxes can each be broken out on
    //    the receipt without double-counting the total.
    const secondaryRate = rateFor(rule.secondaryTaxRateId);
    const secondaryPct = secondaryRate ? secondaryRate.percent / 100 : 0;
    const secondaryMode: TaxMode = secondaryRate
      ? (rule.secondaryTaxMode ?? 'exclusive')
      : 'none';
    let secondaryTax = 0;
    if (secondaryMode === 'exclusive') {
      const secondaryBase =
        base + serviceCharge + (rule.taxMode === 'exclusive' ? tax : 0);
      secondaryTax = secondaryBase * secondaryPct;
    } else if (secondaryMode === 'inclusive') {
      secondaryTax =
        secondaryPct > 0 ? taxableAmount - taxableAmount / (1 + secondaryPct) : 0;
    }

    // Exclusive tax (primary or secondary) is added on top; inclusive tax is
    // already inside the price and reported only.
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
      taxPercent: rate?.percent ?? 0,
      serviceCharge,
      tax,
      secondaryTaxRateId: secondaryRate?.id,
      secondaryTaxName: secondaryRate?.name,
      secondaryTaxMode: secondaryMode,
      secondaryTaxPercent: secondaryRate?.percent ?? 0,
      secondaryTax,
      gross,
    };
  });

  const sumGross = categories.reduce((sum, c) => sum + c.gross, 0);
  // after_tax: the whole discount comes off the final gross.
  const grandTotal = before ? sumGross : Math.max(0, sumGross - discount);

  const exclusiveTaxTotal =
    categories
      .filter((c) => c.taxMode === 'exclusive')
      .reduce((sum, c) => sum + c.tax, 0) +
    categories
      .filter((c) => c.secondaryTaxMode === 'exclusive')
      .reduce((sum, c) => sum + c.secondaryTax, 0);
  const inclusiveTaxTotal =
    categories
      .filter((c) => c.taxMode === 'inclusive')
      .reduce((sum, c) => sum + c.tax, 0) +
    categories
      .filter((c) => c.secondaryTaxMode === 'inclusive')
      .reduce((sum, c) => sum + c.secondaryTax, 0);

  return {
    netSubtotal: totalBase,
    discountTotal: discount,
    serviceChargeTotal: categories.reduce((sum, c) => sum + c.serviceCharge, 0),
    exclusiveTaxTotal,
    inclusiveTaxTotal,
    taxTotal: exclusiveTaxTotal + inclusiveTaxTotal,
    categories,
    grandTotal,
  };
}

// A display row for a receipt/summary: a service charge, an included (reported)
// tax, or an added tax. Surfaces render these in their own styling; inclusive
// rows are informational (already in the total), added rows are part of the total.
export interface TaxSummaryRow {
  key: string;
  label: string; // e.g. "Service charge", "VAT included", "VAT"
  amount: number;
  kind: 'service' | 'tax_included' | 'tax_added';
}

/**
 * Reduce a breakdown to the rows a receipt/summary should show: a service-charge
 * row (if any), then one row per (tax name + mode) — "VAT included ฿X" for
 * inclusive, "VAT ฿X" for exclusive (added). Empty when nothing applies.
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

  const byKey = new Map<string, { name: string; mode: TaxMode; amount: number }>();
  for (const c of breakdown.categories) {
    if (c.tax > 0 && c.taxMode !== 'none') {
      const name = c.taxName ?? 'Tax';
      const key = `${c.taxMode}:${name}`;
      const cur = byKey.get(key) ?? { name, mode: c.taxMode, amount: 0 };
      cur.amount += c.tax;
      byKey.set(key, cur);
    }
    // Secondary tax: an added row when 'exclusive', an included row when 'inclusive'.
    if (c.secondaryTax > 0 && c.secondaryTaxMode !== 'none') {
      const name = c.secondaryTaxName ?? 'Tax';
      const key = `${c.secondaryTaxMode}:${name}`;
      const cur = byKey.get(key) ?? { name, mode: c.secondaryTaxMode, amount: 0 };
      cur.amount += c.secondaryTax;
      byKey.set(key, cur);
    }
  }
  for (const [key, v] of byKey) {
    rows.push({
      key,
      label: v.mode === 'inclusive' ? `${v.name} included` : v.name,
      amount: v.amount,
      kind: v.mode === 'inclusive' ? 'tax_included' : 'tax_added',
    });
  }
  return rows;
}

/** Round a ฿ amount to at most 2 decimals for display (e.g. back-calc VAT). */
export const roundTHB = (n: number): number => Math.round(n * 100) / 100;

/** Sum category inputs that share a category into one entry per category. */
export function groupTaxInputs(inputs: TaxCategoryInput[]): TaxCategoryInput[] {
  const byCat = new Map<TaxableCategory, number>();
  for (const i of inputs) {
    byCat.set(i.category, (byCat.get(i.category) ?? 0) + i.base);
  }
  return [...byCat.entries()].map(([category, base]) => ({ category, base }));
}
