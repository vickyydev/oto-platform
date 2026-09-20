import type { Satang } from './money';
import type { TaxConfigShape, TaxableCategory } from './catalog-shapes';
import type {
  DiscountComponentTarget,
  LineBreakdownItem,
  PricingContext,
  TicketCartLine,
} from './pricing';
import {
  breakdownComponentKey,
  componentKey,
  computeLineBreakdown,
  lineComponentBases,
  priceCartLine,
  SERVICE_FEE_ROW_KEY,
} from './pricing';
import type { DiscountTarget, ManualDiscount } from './discount';
import { computeManualDiscount, discountTargetBase, rowMatchesTarget } from './discount';
import type { PromoDiscount } from './promo';
import type { DiscountAllocation, TaxBreakdown, TaxCategoryInput } from './tax';
import { computeTaxBreakdown, groupTaxInputs } from './tax';
import type { RoundingPolicy } from './rounding';
import { apportion, DEFAULT_ROUNDING, roundHalfUpSatang } from './rounding';
import { PRICING_ENGINE_VERSION } from './engine';

/**
 * Order totals — a faithful port of the prototype's `lib/sale.ts`
 * (`tillTaxInputs`, `computeTotals`), in satang. This is the single ordering
 * authority for a ticket cart and the only place the discount systems meet.
 */

/**
 * The taxable category one rendered breakdown row's money belongs to:
 *   kids/adults → tickets; the service-fee row → drop_off; an add-on → its own
 *   taxCategoryOverride else addons; socks and anything else → addons.
 * Port of the categoriser inside prototype `tillTaxInputs` (lib/sale.ts:35-46).
 */
function rowTaxCategory(line: TicketCartLine, row: LineBreakdownItem): TaxableCategory {
  if (row.key === SERVICE_FEE_ROW_KEY) return 'drop_off';
  if (row.kind === 'kids' || row.kind === 'adults') return 'tickets';
  if (row.kind === 'addon') {
    return line.addOns.find((addOn) => addOn.id === row.key)?.taxCategoryOverride ?? 'addons';
  }
  return 'addons'; // socks, and any future non-addon kind
}

/** The taxable category prepaid food lands in, if the line carries any. */
function foodTaxCategory(line: TicketCartLine): TaxableCategory | null {
  const food = line.foodProvision;
  if (!food || food.paid <= 0) return null;
  // prepaid items → fnb (taxed now); prepaid credit → stored_value (a
  // stored-value load, untaxed at load; tax is realised when it is spent).
  return food.mode === 'prepaid_items' ? 'fnb' : 'stored_value';
}

/**
 * Map a cart's line components to taxable-category bases. Reuses
 * `computeLineBreakdown` so the bases always sum to the line totals, and routes
 * prepaid food explicitly because it is in the line total without being a
 * breakdown row.
 *
 * A free-item promo line returns no breakdown rows, so its base never reaches
 * the engine while its line total IS in the subtotal and its matching discount
 * IS in the discount total. Under before_tax placement the engine then
 * subtracts a discount with no matching base and the grand total falls by the
 * item's price — the prototype's behaviour, reproduced here, and NOT what the
 * comment at `pages/Till.tsx:569-573` promises ("grandTotal unchanged").
 *
 * WHERE THE GAP SHOWS, precisely: the free-item discount is order-wide, and an
 * order-wide allocation is apportioned across the bases that remain, so on an
 * ordinary cart it comes off ANOTHER category's base and `unappliedDiscount`
 * stays 0 — WE-8 pins exactly that (tickets 213000 → 208000, unapplied 0). It
 * surfaces as `unappliedDiscount` only when nothing is left to absorb it, which
 * is EC-8. Either way the guest pays the item's price less than the comment
 * promises. Recorded as an open question for S2-09a; do not "fix" it here
 * without a ruling, because the fix changes what a guest pays.
 *
 * Port of prototype `tillTaxInputs` (lib/sale.ts:27).
 */
export function ticketCartTaxInputs(
  lines: readonly TicketCartLine[],
  ctx: PricingContext,
): TaxCategoryInput[] {
  const inputs: TaxCategoryInput[] = [];
  for (const line of lines) {
    for (const row of computeLineBreakdown(line, ctx)) {
      inputs.push({ category: rowTaxCategory(line, row), base: row.subtotal });
    }
    const foodCategory = foodTaxCategory(line);
    if (foodCategory) inputs.push({ category: foodCategory, base: line.foodProvision?.paid ?? 0 });
  }
  return groupTaxInputs(inputs);
}

// --- Discount attribution ---------------------------------------------------

/**
 * ATTRIBUTION IS SEQUENTIAL, AND THE ORDER MATTERS AS MUCH AS IT DOES FOR THE
 * AMOUNTS THEMSELVES.
 *
 * Each of the `categoryBasesFor*` helpers below reads the UNDISCOUNTED
 * breakdown — it answers "what did this discount's scope cover", which is a
 * question about the cart, not about the discounts that ran before it. What a
 * discount can actually be attributed to is that scope intersected with WHAT IS
 * LEFT of each category, and that is what `allocateAgainstRemaining` computes,
 * threading one `remaining` map through every discount in order.
 *
 * WHY, WITH THE BILL IT COST. Attribute every discount against the undiscounted
 * breakdown instead and two discounts whose scopes overlap in one category both
 * claim the same base. `computeTaxBreakdown` clamps the second one to what is
 * left and drops the surplus into `unappliedDiscount` — so the money simply
 * disappears from the guest's side of the bill. Measured on the seeded config
 * (7 % inclusive on every category, the only state reachable today):
 *
 *   3 kids @ 89000 = 267000 tickets, 2 socks + 2 lockers = 30000 addons;
 *   KIDS23 (tickets, 23 %) then TICKETSFREE (tickets, 100 %) → 61410 + 235590
 *   = 297000 of discount against a 297000 subtotal.
 *     prototype total 0 — the guest walks out having paid nothing
 *     undiscounted-base attribution 30000, with 30000 "unapplied"
 *
 * That is ฿300 charged for socks and lockers the prototype gives away. It is
 * not a corner: a differential run of 20,000 generated carts per shape against
 * the prototype's arithmetic found the same class of divergence on 2.96 % of
 * two-scoped-code carts (worst +฿798) and 9.69 % of mixed carts (worst +฿4,660)
 * — and 2,528 out of 2,528 divergences overcharged the guest, not one favoured
 * them. Incidence depends on the generator; the direction does not.
 *
 * The prototype's warning that licenses attribution at all (`lib/tax.ts:99-106`)
 * is scoped to "once divergent rules become configurable … spreading it across
 * DIFFERENTLY-TAXED categories would shift the grand total". On the seeded
 * config every category shares one rule, so the prototype's premise holds, its
 * spread is exact, and the total must not move. Allocating against what remains
 * keeps the attribution (TX-ATTR-1..5 still show their differences under
 * genuinely divergent rules) and restores the prototype's total here.
 *
 * The surplus a scope can no longer absorb becomes an ORDER-WIDE allocation
 * rather than being dropped: `computeTaxBreakdown` then spreads it over
 * whatever is left, which is the prototype's own arithmetic for money that was
 * never attributable in the first place. `computeTaxBreakdown` itself still
 * drops a named allocation it cannot place — that contract is unchanged, and
 * TX-ATTR-5 pins it for a caller that hands it one directly.
 */

/**
 * Split one discount amount across the taxable categories its scope actually
 * covered, in proportion to how much of each it covered.
 *
 * A scope is not a category: `addOns` covers the socks row and every add-on
 * row, and an add-on carrying a `taxCategoryOverride` puts its money somewhere
 * else entirely (the seeded refillable cup is `fnb`). So the split is taken
 * from the rows the scope matched, not from the scope's name. An empty result
 * means the scope matched nothing, and the caller treats the discount as
 * order-wide rather than inventing a category for it.
 *
 * `everything` returns empty ON PURPOSE and the early return is load-bearing:
 * `rowMatchesTarget` says (correctly) that every row is inside that scope, but
 * an order-wide code is not attributed per category — it is apportioned across
 * what remains, at the end, which is the prototype's arithmetic for a discount
 * that targeted nothing. Fixture EC-5 pins it.
 */
function categoryBasesForTarget(
  lines: readonly TicketCartLine[],
  target: DiscountTarget,
  ctx: PricingContext,
): Map<TaxableCategory, Satang> {
  const bases = new Map<TaxableCategory, Satang>();
  if (target.kind === 'everything') return bases;
  for (const line of lines) {
    for (const row of computeLineBreakdown(line, ctx)) {
      if (!rowMatchesTarget(row, line.packageId, target, ctx.socks.addOnId)) continue;
      const category = rowTaxCategory(line, row);
      bases.set(category, (bases.get(category) ?? 0) + row.subtotal);
    }
  }
  return bases;
}

/**
 * The categories one COMPONENT of a line falls into. Matched by the same
 * component key `lineComponentBases` uses, so the attribution lands on exactly
 * the rows the discount was resolved against — not on anything that merely
 * shares a scope name.
 */
function categoryBasesForComponent(
  line: TicketCartLine,
  target: DiscountComponentTarget,
  ctx: PricingContext,
): Map<TaxableCategory, Satang> {
  const wanted = componentKey(target);
  const bases = new Map<TaxableCategory, Satang>();
  for (const row of computeLineBreakdown(line, ctx)) {
    if (breakdownComponentKey(row) !== wanted) continue;
    const category = rowTaxCategory(line, row);
    bases.set(category, (bases.get(category) ?? 0) + row.subtotal);
  }
  return bases;
}

/** The categories one whole cart line's money falls into, and how much of each. */
function categoryBasesForLine(
  line: TicketCartLine,
  ctx: PricingContext,
): Map<TaxableCategory, Satang> {
  const bases = new Map<TaxableCategory, Satang>();
  for (const row of computeLineBreakdown(line, ctx)) {
    const category = rowTaxCategory(line, row);
    bases.set(category, (bases.get(category) ?? 0) + row.subtotal);
  }
  const foodCategory = foodTaxCategory(line);
  if (foodCategory) {
    bases.set(foodCategory, (bases.get(foodCategory) ?? 0) + (line.foodProvision?.paid ?? 0));
  }
  return bases;
}

/** What is left of each taxable category before any discount is attributed. */
function remainingCategoryBases(
  lines: readonly TicketCartLine[],
  ctx: PricingContext,
): Map<TaxableCategory, Satang> {
  const remaining = new Map<TaxableCategory, Satang>();
  for (const input of ticketCartTaxInputs(lines, ctx)) {
    remaining.set(input.category, (remaining.get(input.category) ?? 0) + input.base);
  }
  return remaining;
}

/**
 * Turn one discount amount plus the categories its scope covered into
 * allocations, against what is LEFT of those categories, and decrement what is
 * left by what it took.
 *
 * An empty or zero-capacity intersection means "there is nothing of this scope
 * left to reduce" and yields a single order-wide allocation — never a guess and
 * never a silent loss. The same is true of the part of an over-scoped discount
 * that the scope cannot absorb.
 */
function allocateAgainstRemaining(
  amount: Satang,
  scopeBases: Map<TaxableCategory, Satang>,
  remaining: Map<TaxableCategory, Satang>,
): DiscountAllocation[] {
  if (amount <= 0) return [];
  const entries = [...scopeBases.entries()]
    .map(([category, base]) => [category, Math.min(base, remaining.get(category) ?? 0)] as const)
    .filter(([, capacity]) => capacity > 0);
  if (entries.length === 0) return [{ amount }];

  const capacity = entries.reduce((sum, [, left]) => sum + left, 0);
  const attributed = Math.min(amount, capacity);
  // Largest remainder again, for the same reason as everywhere else: the parts
  // must be whole satang and must sum back to the amount exactly.
  const shares =
    entries.length === 1
      ? [attributed]
      : apportion(
          attributed,
          entries.map(([, left]) => left),
        );

  const allocations: DiscountAllocation[] = [];
  entries.forEach(([category], index) => {
    const share = shares[index] ?? 0;
    if (share <= 0) return;
    allocations.push({ amount: share, category });
    remaining.set(category, (remaining.get(category) ?? 0) - share);
  });
  const surplus = amount - attributed;
  if (surplus > 0) allocations.push({ amount: surplus });
  return allocations;
}

/** What one applied promo code took off the order. */
export interface AppliedPromo {
  code: string;
  label: string;
  type: PromoDiscount['type'];
  amount: Satang;
}

export interface TicketCartTotals {
  /** Sum of line totals, free-item promo lines included. */
  subtotal: Satang;
  /** Resolved satang per manual discount id (the prototype's `manualAmounts`). */
  manualAmounts: Record<string, Satang>;
  /** The prototype's `manualDiscountAmount`. */
  manualDiscountTotal: Satang;
  /** The prototype's `discountAmount` — promo codes only. */
  promoDiscountTotal: Satang;
  /** The prototype's `scannedDiscounts`. */
  appliedPromos: AppliedPromo[];
  discountTotal: Satang;
  serviceChargeTotal: Satang;
  taxTotal: Satang;
  taxBreakdown: TaxBreakdown;
  /** What the guest pays. */
  total: Satang;
  /** Stamped onto the sale so a later engine change is traceable. */
  engineVersion: string;
}

export interface CartTotalsOptions {
  /** Applies to manual percent discounts only; see rounding.ts. */
  rounding?: RoundingPolicy;
  /**
   * What to do when a line's stored `lineTotal` disagrees with what `ctx`
   * prices it at — see `findStaleLines`.
   *
   * 'throw' (the default) refuses to total the cart and names the lines.
   *
   * 'trust_stored' reproduces the pre-guard drift instead of refusing. IT DOES
   * NOT RETURN THE RECORDED TOTAL, and an earlier version of this comment said
   * it did, which is the sort of sentence a report gets written against. What
   * it actually returns: `subtotal` from the STORED line totals, and every tax
   * base — and therefore `total` — re-derived from `ctx`. On the one-line cart
   * the tests pin, a stored 52000 under a weekend `ctx` comes back as
   * `subtotal: 52000, total: 62000`: publish that as a historical figure and a
   * guest who paid ฿520 is reported at ฿620.
   *
   * So it is a DIAGNOSTIC, not a reporting route: use it to reproduce and
   * measure the drift a stale cart causes. A report re-deriving a historical
   * sale must rebuild the context the sale was priced under — that is what the
   * sale's stored `pricing_mode` and `engineVersion` are for — and then the
   * lines are not stale at all; where the context cannot be rebuilt, the stored
   * totals are the record and the engine has nothing to add to them.
   */
  staleLines?: 'throw' | 'trust_stored';
}

/**
 * Lines whose stored `lineTotal` is not what `ctx` prices them at — the ids
 * only, in cart order.
 *
 * WHY THIS HAS TO EXIST. `computeTicketCartTotals` takes the subtotal from the
 * STORED `line.lineTotal` and every tax base from `ctx`, and until this check
 * nothing reconciled the two. The prototype never notices because it defaults
 * the rate mode from `todayRateMode()` at BOTH ends (`lib/pricing.ts:150`,
 * `lib/pricing.ts:190`), so the two always move together; the port promoted the
 * mode to a caller-supplied argument and added no guard. A cart priced on a
 * Friday evening and still open when the clock passes into Saturday is then
 * totalled with a weekend `ctx`: the subtotal is the weekday figure the guest
 * was quoted, the tax bases are the weekend figures, and the receipt shows two
 * different sales added together with no discount to explain the gap.
 *
 * Promo lines are exempt: their total is their item's shelf price and has no
 * participants to re-price.
 *
 * WHAT IT WILL REFUSE THAT IS NOT STALE, stated because S2-13 walks straight
 * into it: a drop-off line before staff have chosen the length. The prototype
 * keeps that line in the cart at `lineTotal: 0` on purpose — "until
 * `lengthChosen` is true the line is unpriced (the caller passes a placeholder
 * ticket only to satisfy the type)" (lib/dropoff.ts:52-59, :87), and its
 * re-pricing pass writes the 0 back on every edit (lib/dropoff.ts:139-141).
 * Hand that cart here and the line's stored 0 will not equal what `ctx` prices
 * a kid at, so the cart is refused and the line is named.
 *
 * THIS FUNCTION CANNOT TELL THE TWO APART TODAY, and must not guess: "not yet
 * priced" and "priced under another rate mode" both look like a stored total
 * that disagrees with `ctx`, and treating every 0 as deliberate would let a
 * genuinely mis-priced line through at nothing. The distinguishing fact lives
 * on the prototype's `CartLine.dropOff.lengthChosen`, which this port has not
 * modelled — `TicketCartLine` carries `serviceFee` and `foodProvision` but no
 * drop-off block, because drop-off is S2-13's ticket.
 *
 * So S2-13 picks one, and it is a decision, not a patch: either carry
 * `lengthChosen` onto the line and exempt an unpriced drop-off line here the
 * way promo lines are exempt, or keep unpriced lines out of the cart that is
 * totalled until the length is chosen. What it must NOT do is reach for
 * `staleLines: 'trust_stored'` — that is a diagnostic, it re-derives every tax
 * base from `ctx` anyway, and on an unpriced line it would charge the guest for
 * play time the till is showing as ฿0.
 */
export function findStaleLines(lines: readonly TicketCartLine[], ctx: PricingContext): string[] {
  return lines
    .filter((line) => !line.promoItem && line.lineTotal !== priceCartLine(line, ctx))
    .map((line) => line.id);
}

/**
 * Re-price every line against `ctx`, returning a new array. The explicit repair
 * for a stale cart, kept separate from totalling because re-pricing a cart a
 * guest has already been quoted is a decision someone makes, not something an
 * engine does quietly on their behalf.
 */
export function repriceCartLines(
  lines: readonly TicketCartLine[],
  ctx: PricingContext,
): TicketCartLine[] {
  return lines.map((line) => ({ ...line, lineTotal: priceCartLine(line, ctx) }));
}

/**
 * Totals for a ticket cart.
 *
 * THE ORDER, from prototype `computeTotals` (lib/sale.ts:73), and it is not
 * cosmetic — reversing steps 2 and 3 on the worked example WE-6 moves a ฿2,130
 * bill by ฿20:
 *   1. subtotal = Σ line totals (the free-item promo line included)
 *   2. ALL manual discounts: line-scope in array order, then order-scope in
 *      array order against what those left
 *   3. THEN promo codes, each against the running balance the previous left
 *   4. the whole discount into the tax cascade, placed before or after tax,
 *      each part attributed to the category it targeted
 *
 * Step 0, which the prototype does not have: refuse a cart whose stored line
 * totals were not priced under this context. See `findStaleLines`.
 */
export function computeTicketCartTotals(
  lines: readonly TicketCartLine[],
  promos: readonly PromoDiscount[],
  manualDiscounts: readonly ManualDiscount[],
  config: TaxConfigShape,
  ctx: PricingContext,
  options: CartTotalsOptions = {},
): TicketCartTotals {
  const rounding = options.rounding ?? DEFAULT_ROUNDING;

  if ((options.staleLines ?? 'throw') === 'throw') {
    const stale = findStaleLines(lines, ctx);
    if (stale.length > 0) {
      throw new Error(
        `Cart lines were not priced under this pricing context (${ctx.mode}): ` +
          `${stale.join(', ')}. Re-price with repriceCartLines, or pass ` +
          `staleLines: 'trust_stored' to re-derive a historical sale as recorded.`,
      );
    }
  }

  const subtotal = lines.reduce((acc, line) => acc + line.lineTotal, 0);

  const lineAmounts: Record<string, Satang> = {};
  const componentBases: Record<string, Record<string, Satang>> = {};
  const linesById = new Map<string, TicketCartLine>();
  for (const line of lines) {
    lineAmounts[line.id] = line.lineTotal;
    componentBases[line.id] = lineComponentBases(line, ctx);
    linesById.set(line.id, line);
  }
  const manual = computeManualDiscount(
    manualDiscounts,
    subtotal,
    lineAmounts,
    componentBases,
    rounding,
  );

  // Each discount is placed in the tax cascade against the category it actually
  // targeted, and against what is LEFT of that category once the discounts
  // before it have taken their share; see the attribution note above for what
  // reading the undiscounted breakdown instead costs a guest, and
  // computeTaxBreakdown for what spreading it instead costs on a tax return.
  //
  // THIS LOOP READS ONE AMOUNT PER DISCOUNT OUT OF A MAP KEYED BY ID, so it is
  // correct only while the ids are distinct. `computeManualDiscount` refuses a
  // repeated id for exactly this reason (and states the ฿250 it used to cost);
  // it has already run, so by here every id is unique and every amount is its
  // own discount's.
  const remaining = remainingCategoryBases(lines, ctx);
  const allocations: DiscountAllocation[] = [];
  for (const discount of manualDiscounts) {
    const amount = manual.amounts[discount.id] ?? 0;
    if (amount <= 0) continue;
    if (discount.scope !== 'line' || !discount.targetLineId) {
      allocations.push({ amount }); // order scope — genuinely order-wide
      continue;
    }
    const line = linesById.get(discount.targetLineId);
    if (!line) {
      allocations.push({ amount });
      continue;
    }
    const bases = discount.targetComponent
      ? categoryBasesForComponent(line, discount.targetComponent, ctx)
      : categoryBasesForLine(line, ctx);
    allocations.push(...allocateAgainstRemaining(amount, bases, remaining));
  }

  // Manual discounts come off first; codes apply to what remains. Several
  // stackable codes apply SEQUENTIALLY, each against the balance the previous
  // one left, so the order can never go negative.
  let running = subtotal - manual.total;
  let promoDiscountTotal = 0;
  const appliedPromos: AppliedPromo[] = [];
  for (const promo of promos) {
    const target = promo.target ?? { kind: 'everything' as const };
    // A free_item code is deliberately based on `running` — the balance that
    // already includes its own synthetic line — so its amount comes out as
    // exactly the item's price.
    const base =
      promo.type === 'free_item' || target.kind === 'everything'
        ? running
        : Math.min(discountTargetBase(lines, target, ctx), running);
    let amount =
      promo.type === 'fixed' || promo.type === 'free_item'
        ? Math.min(promo.value, base)
        : // The prototype leaves this fractional (`base * value/100`, no
          // rounding at all — lib/sale.ts:109). Integer satang forces one
          // rounding step; half-up at the satang, per SPRINT_2_PLAN.md. Note
          // this removes the prototype's ≤฿0.50 asymmetry between a manual
          // percent discount and an identical promo percentage, which was an
          // artefact of rounding one path to whole baht and not the other.
          roundHalfUpSatang((base * promo.value) / 100);
    amount = Math.min(amount, running);
    promoDiscountTotal += amount;
    running -= amount;
    appliedPromos.push({ code: promo.code, label: promo.label, type: promo.type, amount });
    // A free_item code's own line contributes no taxable base, so there is no
    // category to attribute it to and it stays order-wide. Order-wide means
    // apportioned across whatever base remains, so on WE-8 the 5000 comes off
    // the TICKETS base (213000 → 208000) with unappliedDiscount 0 — the
    // shortfall is real but it is somebody else's base that absorbs it, not a
    // reported gap. It only reaches unappliedDiscount when nothing is left to
    // absorb it, which is EC-8.
    if (promo.type === 'free_item' || target.kind === 'everything') {
      if (amount > 0) allocations.push({ amount });
    } else {
      allocations.push(
        ...allocateAgainstRemaining(amount, categoryBasesForTarget(lines, target, ctx), remaining),
      );
    }
  }

  const discountTotal = manual.total + promoDiscountTotal;
  const taxBreakdown = computeTaxBreakdown(ticketCartTaxInputs(lines, ctx), allocations, config);

  return {
    subtotal,
    manualAmounts: manual.amounts,
    manualDiscountTotal: manual.total,
    promoDiscountTotal,
    appliedPromos,
    discountTotal,
    serviceChargeTotal: taxBreakdown.serviceChargeTotal,
    taxTotal: taxBreakdown.taxTotal,
    taxBreakdown,
    total: taxBreakdown.grandTotal,
    engineVersion: PRICING_ENGINE_VERSION,
  };
}
