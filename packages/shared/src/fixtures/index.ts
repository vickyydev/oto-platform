import raw from './pricing-regression.json';
import type { TaxableCategory, TaxConfigShape, WWPriceShape } from '../catalog-shapes';
import type { DiscountTarget, ManualDiscount } from '../discount';
import type { PromoDiscount } from '../promo';
import type { RateMode } from '../pricing-mode';
import type { Satang } from '../money';
import type { DiscountAllocation } from '../tax';

/**
 * The S2-09a regression fixtures, typed.
 *
 * The figures in the JSON are derived from the prototype's code and seeded
 * catalogue, not produced by this engine — see the file's own `about` block,
 * which also carries the two standards the fixtures hold themselves to after
 * hand-written values in two cases were found to be concealing real defects.
 * They are exported from the package so the API's own tests can assert the same
 * numbers end to end rather than re-deriving them.
 */

export interface FixtureAddOn {
  name: string;
  price: Satang;
}

/** A catalogue menu item, for the free-item promo cases. */
export interface FixtureMenuItem {
  name: string;
  price: Satang;
}

export interface FixturePackage {
  name: string;
  prices: Record<string, WWPriceShape>;
  adultRules?: Record<
    string,
    { kind: string; price?: WWPriceShape; freeAdults?: number; overflow?: string }
  >;
  /**
   * Set on the `x-` packages, which are NOT in the prototype's seed. They exist
   * only for adult-rule branches the seeded catalogue cannot reach, and the
   * note on each says which branch and why the seed cannot reach it.
   */
  note?: string;
}

/**
 * A cart line as the till would build it. There is deliberately NO `lineTotal`
 * here: the harness prices every line through `priceCartLine`, because a
 * hand-written total is a number that can silently stop matching the engine —
 * which is exactly how the prepaid-food defect stayed hidden (see EC-4's note).
 * A free-item promo line is not written here either; it is produced by applying
 * the promo, the way the till produces it.
 */
export interface FixtureLine {
  id: string;
  package: string;
  tier: string;
  kids: number;
  adults: number;
  socks?: number;
  addOns?: {
    ref: string;
    quantity: number;
    taxCategoryOverride?: TaxableCategory;
    /** Sizes a stocked add-on was split across; `quantity` stays the sum. */
    variantBreakdown?: { variantId: string; variantLabel: string; quantity: number }[];
  }[];
  serviceFee?: { label: string; amount: Satang };
  foodProvision?: { mode: 'prepaid_items' | 'prepaid_credit'; paid: Satang };
}

/**
 * [breakdown key, unit price, quantity, subtotal] — plus the row LABEL as an
 * optional fifth element, asserted only by the cases that care about it (the
 * variant summary a receipt prints). Rows without it assert the money only.
 */
export type FixtureBreakdownRow =
  | [string, Satang, number, Satang]
  | [string, Satang, number, Satang, string];

export interface FixtureCategoryExpectation {
  category: TaxableCategory;
  base?: Satang;
  taxMode?: string;
  serviceCharge?: Satang;
  tax?: Satang;
  secondaryTax?: Satang;
  gross?: Satang;
}

/**
 * What one applied code came to, and whether it found anything left in its own
 * scope to take. `exhausted` asserts `AppliedPromo.exhaustedReason` is set —
 * the visible half of ruling 2, so a code that spends nothing cannot silently
 * look like a code nobody scanned.
 */
export interface FixtureAppliedPromo {
  code: string;
  amount: Satang;
  exhausted?: boolean;
}

export interface FixtureCartExpectation {
  lineTotals?: Record<string, Satang>;
  subtotal?: Satang;
  manualAmounts?: Record<string, Satang>;
  manualDiscountTotal?: Satang;
  promoDiscountTotal?: Satang;
  discountTotal?: Satang;
  serviceChargeTotal?: Satang;
  inclusiveTaxTotal?: Satang;
  exclusiveTaxTotal?: Satang;
  taxTotal?: Satang;
  unappliedDiscount?: Satang;
  total?: Satang;
  categories?: FixtureCategoryExpectation[];
  breakdown?: Record<string, FixtureBreakdownRow[]>;
  taxRows?: { key: string; label: string; amount: Satang; kind: string }[];
  appliedPromos?: FixtureAppliedPromo[];
}

export interface FixtureCartCase {
  id: string;
  title: string;
  /** Rule ids from POS_RULES_RECONCILIATION.md §2 — see `rulesCovered`. */
  rules: string[];
  mode: RateMode;
  taxConfig: string;
  rounding?: 'satang' | 'baht';
  lines: FixtureLine[];
  manualDiscounts?: ManualDiscount[];
  /**
   * Promo codes exactly as the catalogue stores them — a `free_item` code
   * carries `value: 0` and a `freeItemId`, and the harness resolves and applies
   * it the way the till does.
   */
  promos?: (PromoDiscount & { target?: DiscountTarget })[];
  /**
   * Overrides a line's derived total to a figure it was NOT priced at under
   * this case's mode — the deliberately stale cart, for the guard that refuses
   * to total one. Only EC-16 uses it.
   */
  staleLineTotals?: Record<string, Satang>;
  /** Set when the case pins a refusal: a substring of the expected message. */
  expectThrows?: string;
  expect: FixtureCartExpectation;
  note?: string;
}

export interface FixtureTaxCase {
  id: string;
  title: string;
  rules: string[];
  taxConfig: string;
  inputs: { category: TaxableCategory; base: Satang }[];
  /** A plain order-wide total. Cases that attribute a discount use `discounts`. */
  discountTotal?: Satang;
  /** Discounts carrying the category each targeted; overrides `discountTotal`. */
  discounts?: DiscountAllocation[];
  expect: {
    netSubtotal?: Satang;
    serviceChargeTotal?: Satang;
    inclusiveTaxTotal?: Satang;
    exclusiveTaxTotal?: Satang;
    taxTotal?: Satang;
    unappliedDiscount?: Satang;
    grandTotal?: Satang;
    categories?: FixtureCategoryExpectation[];
  };
  note?: string;
}

export interface FixtureRateModeCase {
  id: string;
  date: string;
  rules: string[];
  expect: { mode: RateMode; reason: string; overrideName?: string };
  note?: string;
}

export interface FixtureBusinessDateCase {
  id: string;
  title: string;
  instant: string;
  timeZone: string;
  dayStart: string;
  expect: { branchDate: string; businessDate: string };
  note?: string;
}

/**
 * One instant at one branch, and everything with a date on it that follows from
 * it: which trading day the sale belongs to, which of the two price sets it is
 * charged at (ruling 3) and whether a code's validity window is still open
 * (ruling 4). Both rulings are decisions recorded on 2026-09-20, not rules
 * found in the repository, and these are the boundary cases that pin them.
 *
 * `utcDate` and `promoAcceptedUnderUtc` are here to keep the rule the platform
 * REPLACED visible: the prototype validates a code against the UTC date while
 * pricing the same cart from local midnight, and a case where the two answers
 * differ is worth more than a sentence saying they can.
 */
export interface FixtureTradingDayCase {
  id: string;
  title: string;
  rules: string[];
  /** ISO 8601 instant. */
  instant: string;
  timeZone: string;
  /** The branch's `business_day_start`, HH:MM. */
  dayStart: string;
  promo?: { validFrom?: string; validUntil?: string };
  expect: {
    branchDate: string;
    businessDate: string;
    utcDate: string;
    mode: RateMode;
    reason: string;
    promoAccepted?: boolean;
    /** Only where the UTC rule gives a DIFFERENT answer from the business date. */
    promoAcceptedUnderUtc?: boolean;
  };
  note?: string;
}

export interface PricingFixtures {
  about: string[];
  /**
   * Every rule id the file claims to exercise, all of them from
   * `docs/architecture/POS_RULES_RECONCILIATION.md` §2. The test
   * "every rule the fixture file claims is a real catalogue rule, and every one
   * is exercised" reads that document and holds this list to it in both
   * directions, so a citation cannot rot into a number that means something
   * else — which is what happened to the `R66`/`R43`/`R75` ids this replaced.
   */
  rulesCovered: string[];
  catalog: {
    socks: { addOnId: string; price: Satang; label: string };
    addOns: Record<string, FixtureAddOn>;
    menuItems: Record<string, FixtureMenuItem>;
    packages: Record<string, FixturePackage>;
    holidays: { name: string; startsOn: string; endsOn: string }[];
  };
  taxConfigs: Record<string, TaxConfigShape & { note?: string }>;
  cartCases: FixtureCartCase[];
  taxCases: FixtureTaxCase[];
  rateModeCases: FixtureRateModeCase[];
  businessDateCases: FixtureBusinessDateCase[];
  tradingDayCases: FixtureTradingDayCase[];
}

// The compiler infers the JSON's structure literally and widens unions across
// array entries, which turns every optional field into a type the cases cannot
// share. The shape above is the contract; the test that walks every case is
// what actually validates the file.
export const PRICING_FIXTURES = raw as unknown as PricingFixtures;
