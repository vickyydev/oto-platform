import type { Satang } from './money';

/**
 * Rounding — the one place a fraction becomes money.
 *
 * The prototype has NO rounding anywhere inside the engine (`lib/tax.ts:258`
 * `roundTHB` is a display helper; the CSV export uses `.toFixed(2)`). It can
 * afford that because it carries baht as floats and only ever prints them. We
 * store integer satang, so a rounding step has to exist and where it goes is a
 * decision, not a detail. The decision, from SPRINT_2_PLAN.md "Money and time":
 *
 *   "percent discounts and inclusive-VAT back-calculation round half-up to the
 *    satang per line component, totals are sums of rounded components"
 *
 * So: round once, half-up, at the satang, on each component (a service charge,
 * a tax figure, one discount amount); never round a total — a total is the sum
 * of components that were already rounded. That keeps a printed receipt's rows
 * adding up to its printed total, which is the property that actually matters
 * at the counter.
 *
 * Half-up (ties away from zero) is chosen because it is what Thai receipts show
 * and what the prototype's only rounding call — `Math.round` in
 * `lib/manualDiscount.ts:11` — already does. JS `Math.round` breaks ties toward
 * +∞, which is the same thing for non-negative input.
 *
 * THE NON-NEGATIVE PREMISE HAS ONE HOLE, and it is named here rather than
 * assumed away. Every amount the engine rounds is non-negative — a price, a
 * tax, a service charge, a manual discount (`resolveManualDiscountAmount`
 * clamps a negative percentage to 0) — EXCEPT a promo code stored with a
 * negative value. The prototype does not clamp one either: `base * (value/100)`
 * with no guard (lib/sale.ts:109), so a −50 % code is a surcharge on its side
 * too, and both engines then refuse to put it in the tax cascade (the prototype
 * at `Math.max(0, discountTotal)`, lib/tax.ts:91; the port by never allocating
 * a non-positive amount). What is OURS and not the prototype's is this
 * rounding: the prototype leaves the figure fractional, we must not, and on a
 * negative tie `Math.round` goes toward +∞ — −166.5 becomes −166, which is
 * half-up toward zero rather than away from it. Fixture EC-23 pins the whole
 * shape. The place to stop a negative value is the catalogue that stores the
 * code, not here.
 */

/**
 * What unit a *manual discount percentage* rounds to.
 *
 * `satang` is the platform rule (the plan, above). `baht` exists because the
 * prototype's `Math.round(base * pct/100)` operates on BAHT: a 10 % manual
 * discount on ฿973 is ฿97 there, ฿97.30 here. That is a ฿0.30 divergence on one
 * line, and it is an artefact of the prototype carrying baht rather than a rule
 * the park's staff asked for — but it is reproducible, and a branch can be put
 * back on it by configuration if the owner says the till must keep rounding
 * discounts to the baht. See POS_RULES_RECONCILIATION.md:206, which already
 * says rounding becomes `branch_tax_config` config.
 */
export type RoundingUnit = 'satang' | 'baht';

/** Only half-up ships today; the union exists so a later mode is additive. */
export type RoundingMode = 'half_up';

export interface RoundingPolicy {
  unit: RoundingUnit;
  mode: RoundingMode;
}

/** The platform default (SPRINT_2_PLAN.md "Money and time"). */
export const DEFAULT_ROUNDING: RoundingPolicy = { unit: 'satang', mode: 'half_up' };

/**
 * The prototype's whole-baht manual-discount rounding, kept so the divergence
 * is testable instead of asserted. Not the default.
 */
export const PROTOTYPE_BAHT_ROUNDING: RoundingPolicy = { unit: 'baht', mode: 'half_up' };

/**
 * Round a fractional satang amount to whole satang, half-up. Used for every
 * tax, service-charge and promo figure — the places where the prototype simply
 * left a float and we cannot.
 */
export function roundHalfUpSatang(value: number): Satang {
  // Math.round breaks ties toward +∞. Every amount the engine rounds is
  // non-negative (a price, a tax, a discount magnitude), so that is half-up.
  return Math.round(value);
}

/** Round to the unit a policy names. */
export function roundToPolicy(value: number, policy: RoundingPolicy = DEFAULT_ROUNDING): Satang {
  if (policy.unit === 'baht') return Math.round(value / 100) * 100;
  return Math.round(value);
}

/**
 * `percent` of `base`, rounded once.
 *
 * Written as `(base * percent) / 100` rather than `base * (percent / 100)`:
 * with an integer base and a whole percent the numerator is an exact integer,
 * so the only inexact step is the final division. The other form divides first
 * and can land a hair below a .5 boundary that should have rounded up.
 */
export function percentOf(
  base: Satang,
  percent: number,
  policy: RoundingPolicy = DEFAULT_ROUNDING,
): Satang {
  return roundToPolicy((base * percent) / 100, policy);
}

/**
 * Split `total` across `weights` so the parts are whole satang AND sum to
 * exactly `total` — largest remainder, ties broken by position.
 *
 * WHY NOT just round each share. The prototype apportions a before-tax discount
 * as `discount * (base_i / totalBase)` in floats (`lib/tax.ts:107-108`), so its
 * shares sum to the discount exactly. Rounding each share independently breaks
 * that: a ฿100 discount split three ways would come off the bill as ฿99.99 or
 * ฿100.01 and the receipt would not reconcile. Largest remainder is the
 * cheapest way to keep the prototype's invariant once the parts must be whole.
 *
 * Weights must be non-negative integers (they are satang bases). All-zero
 * weights, or a zero total, give all zeros — matching the prototype's
 * `totalBase > 0` guard.
 *
 * THE SAFE MAGNITUDE, stated properly because an earlier version of this
 * comment stated it wrongly and a comment is what a later reader trusts when
 * raising the limit. The only product formed here is `total × weight`, and it
 * is exact while that product stays at or below `Number.MAX_SAFE_INTEGER`
 * (2^53 − 1 ≈ 9.007e15). With both at the same magnitude B that is
 * B ≤ √(2^53 − 1) ≈ 94,906,265 satang, about ฿949,000 — comfortably above any
 * order a till will ever ring up, and the reason the largest-remainder split is
 * exact in practice. "In practice" is not an assertion: test/pricing-engine
 * "apportion holds its invariants over 200,000 generated splits" runs exactly
 * that, from a fixed seed, and checks the three properties below on every one.
 * An earlier version of this sentence claimed the 200,000 cases had been run
 * when no such loop existed anywhere in the repository.
 *
 * The bound is where the ARITHMETIC is exact, which is not the same as where
 * the function starts answering wrongly, and the test "apportion is exact at
 * the magnitude its comment claims, and the product is not beyond it" now says
 * which is which: it splits AT the bound and checks the result against a BigInt
 * computation of the same split, then shows that one satang past it the product
 * `total × weight` is already a different number from the exact one. Past the
 * bound the sum is still forced (the leftover pass distributes whatever the
 * floors missed), so what degrades first is which share gets the odd satang.
 *
 * The invariants, so the test and the comment cannot drift apart:
 *   1. every part is a non-negative integer;
 *   2. the parts sum to `total` exactly;
 *   3. each part is the exact share rounded either down or up, never further —
 *      `|part_i − total × w_i / Σw| < 1`.
 *
 * The bound is NOT unlimited: the earlier comment claimed a ฿10,000,000
 * discount against a ฿10,000,000 base was "still inside MAX_SAFE_INTEGER", and
 * that pair is 1e9 × 1e9 = 1e18 — roughly 111× TOO LARGE. Anything that
 * apportions at report scale (a month of takings against a comparable weight)
 * is past the bound. If that day comes, the repair is to form the product in
 * BigInt and narrow the quotient back, not to raise this number.
 */
export function apportion(total: Satang, weights: readonly number[]): Satang[] {
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);

  // Integer arithmetic throughout; exact while `total × weight` stays inside
  // Number.MAX_SAFE_INTEGER (see the magnitude note above).
  const floors: number[] = [];
  const remainders: number[] = [];
  for (const weight of weights) {
    const product = total * weight;
    const floor = Math.floor(product / sum);
    floors.push(floor);
    remainders.push(product - floor * sum);
  }

  let leftover = total - floors.reduce((acc, v) => acc + v, 0);
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const out = [...floors];
  for (const { index } of order) {
    if (leftover <= 0) break;
    out[index] = (out[index] ?? 0) + 1;
    leftover -= 1;
  }
  return out;
}
