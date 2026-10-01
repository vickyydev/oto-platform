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
import { computeManualDiscount, rowMatchesTarget } from './discount';
import type { PromoDiscount } from './promo';
import { freeItemLineId, promoNotApplicableReason } from './promo';
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
 * The taxable category a free-item promo's item belongs to: ITS OWN — a menu
 * item is `fnb`, a merch item is `merch`.
 *
 * RULING 1, 2026-09-20, AND IT IS A DOCUMENTED RULE RATHER THAN A CHOICE. Four
 * sources in this repository say a free item goes on the bill at ฿0 and leaves
 * the rest of the bill alone:
 *   - `docs/briefs/POS_BACKEND_LOGIC.md` §6.2 — "free_item adds an item at ฿0.
 *     Respects tax discountPlacement. At EOD this is revenue foregone (a
 *     discount/markdown) — distinct from wallet spend."
 *   - `docs/architecture/POS_RULES_RECONCILIATION.md` R-29 — "free_item adds a
 *     ฿0 line".
 *   - `docs/briefs/AGENCY_PROPOSAL.md`, week 20 — "free-item voucher adds the
 *     item at THB 0.00 … reported as foregone revenue, never wallet spend".
 *   - `docs/progress/SPRINT_2_PLAN.md` — the code "adds the synthetic line and
 *     offsetting discount".
 * The prototype says it four more times (`pages/Till.tsx:569-573`,
 * `lib/pricing.ts:192-194`, `components/till/OrderSummary.tsx:222-225`,
 * `components/till/CustomerDisplay.tsx:287-288`) and states the invariant at
 * `lib/sale.ts:122-124`: "the grand total equals the old subtotal − discount,
 * so existing totals are unchanged".
 *
 * Putting the item's price in its own category is what makes "revenue foregone"
 * true on the books: the cone books as F&B gross ฿50, markdown ฿50, net 0 — the
 * cone was handed over and its stock was drawn, and the markdown sits against
 * the thing that was given away. Attributing it anywhere else says the park gave
 * ฿50 off the tickets instead, which is not what happened.
 */
function promoItemTaxCategory(item: NonNullable<TicketCartLine['promoItem']>): TaxableCategory {
  return item.itemKind === 'merch' ? 'merch' : 'fnb';
}

/**
 * ONE DISCOUNTABLE PIECE OF A CART: a rendered breakdown row, a free-item
 * promo's item, or a line's prepaid food. Three shapes because three kinds of
 * money are in the bill, and only the first is a breakdown row.
 *
 * Every satang of the subtotal is in exactly one unit, and that is the property
 * the rest of this file leans on: the units grouped by category ARE the tax
 * bases, and the units matched by a scope ARE what that scope may discount.
 */
export interface CartUnit {
  lineId: string;
  packageId: string;
  /** The rendered breakdown row this unit is, or null for the other two kinds. */
  row: LineBreakdownItem | null;
  /** Set on the unit that IS a free-item promo line's item. */
  promoItem: NonNullable<TicketCartLine['promoItem']> | null;
  category: TaxableCategory;
  /** Undiscounted. What the unit was worth before any discount ran. */
  base: Satang;
}

/**
 * Split a cart into its discountable units, in cart order.
 *
 * Reuses `computeLineBreakdown` so the row units always sum to the line totals,
 * and routes the other two kinds explicitly because neither is a breakdown row:
 *
 *   - PREPAID FOOD is in the line total without being a row (prototype
 *     `lib/sale.ts:52-60`), and carries its own category.
 *   - A FREE-ITEM PROMO'S ITEM is likewise in the line total without being a
 *     row — `computeLineBreakdown` returns [] for a promo line, deliberately,
 *     because the receipt shows the item and not a ticket breakdown of it.
 *     Until 2026-09-20 that meant its base never reached the tax engine at all,
 *     which is the defect ruling 1 corrects; see `promoItemTaxCategory`.
 *
 * Port of prototype `tillTaxInputs` (lib/sale.ts:27), extended by that ruling.
 *
 * EXPORTED for the sales ledger (S2-09a): `pos.sale_line` stores ONE ROW PER
 * UNIT, because one cart line can hold money from three taxable categories at
 * once and a per-line tax rate is only meaningful on the unit. The API could
 * decompose a cart itself from `computeLineBreakdown` plus the two kinds that
 * are not rows — and would then be a second copy of this rule, drifting from
 * the one the tax bases and the discount scopes are built from. Storing the
 * engine's own units keeps the ledger holding what was computed.
 */
export function cartUnits(lines: readonly TicketCartLine[], ctx: PricingContext): CartUnit[] {
  const units: CartUnit[] = [];
  for (const line of lines) {
    for (const row of computeLineBreakdown(line, ctx)) {
      units.push({
        lineId: line.id,
        packageId: line.packageId,
        row,
        promoItem: null,
        category: rowTaxCategory(line, row),
        base: row.subtotal,
      });
    }
    if (line.promoItem) {
      units.push({
        lineId: line.id,
        packageId: line.packageId,
        row: null,
        promoItem: line.promoItem,
        category: promoItemTaxCategory(line.promoItem),
        // `priceCartLine` says a promo line's total IS its item's shelf price,
        // so reading the item rather than the line keeps the two reconciled and
        // makes a caller that set them apart fail the per-line invariant loudly.
        base: line.promoItem.price,
      });
    }
    const foodCategory = foodTaxCategory(line);
    if (foodCategory) {
      units.push({
        lineId: line.id,
        packageId: line.packageId,
        row: null,
        promoItem: null,
        category: foodCategory,
        base: line.foodProvision?.paid ?? 0,
      });
    }
  }
  return units;
}

/**
 * Map a cart's money to taxable-category bases — one row per category.
 *
 * Every satang of every line total is here, the free-item promo line's included
 * (ruling 1). The invariant that follows, and that the suite asserts per line:
 * a line's total equals the sum of its own tax bases, exactly, with no
 * exceptions — the prototype states it at `lib/sale.ts:50-51`.
 */
export function ticketCartTaxInputs(
  lines: readonly TicketCartLine[],
  ctx: PricingContext,
): TaxCategoryInput[] {
  return groupTaxInputs(
    cartUnits(lines, ctx).map((unit) => ({ category: unit.category, base: unit.base })),
  );
}

// --- Discount attribution ---------------------------------------------------

/**
 * ATTRIBUTION IS SEQUENTIAL, AND THE ORDER MATTERS AS MUCH AS IT DOES FOR THE
 * AMOUNTS THEMSELVES.
 *
 * TWO DIFFERENT QUESTIONS ARE ANSWERED IN THIS FILE AND THEY MUST NOT BE
 * CONFUSED, because getting one of them wrong looks exactly like getting the
 * other one wrong and costs the guest either way:
 *
 *   THE AMOUNT LINE — how much may this discount take? Bounded by what its own
 *   scope has LEFT (ruling 2, the `ledger` in `computeTicketCartTotals`).
 *   THE ATTRIBUTION LINE — which taxable category books what it took? Decided
 *   against what each CATEGORY has left (the `remaining` map, below).
 *
 * `categoryBasesOf` reads the UNDISCOUNTED bases of the units a scope covered —
 * it answers "what did this discount's scope cover", which is a question about
 * the cart, not about the discounts that ran before it. What a discount can
 * actually be attributed to is that scope intersected with WHAT IS LEFT of each
 * category, and that is what `allocateAgainstRemaining` computes, threading one
 * `remaining` map through every discount in order.
 *
 * WHY, WITH THE BILL IT COST. Attribute every discount against the undiscounted
 * breakdown instead and two discounts whose scopes overlap in one category both
 * claim the same base. `computeTaxBreakdown` clamps the second one to what is
 * left and drops the surplus into `unappliedDiscount` — so the money simply
 * disappears from the guest's side of the bill. Measured on the seeded config
 * (7 % inclusive on every category, the only state reachable today), BEFORE
 * ruling 2 bounded the amounts:
 *
 *   3 kids @ 89000 = 267000 tickets, 2 socks + 2 lockers = 30000 addons;
 *   KIDS23 (tickets, 23 %) then TICKETSFREE (tickets, 100 %) → 61410 + 235590
 *   = 297000 of discount against a 297000 subtotal.
 *     prototype total 0 — the guest walks out having paid nothing
 *     undiscounted-base attribution 30000, with 30000 "unapplied"
 *
 * Under ruling 2 that cart's two codes now come to 267000 rather than 297000
 * and the guest pays the 30000 of socks and lockers — by the AMOUNT line, with
 * every satang of discount placed and nothing unapplied. The attribution rule
 * below is unchanged and still load-bearing: reverting it would once again
 * report a discount the cascade never placed. EC-17 pins both halves.
 *
 * That ฿300 was charged for socks and lockers the prototype gives away. It is
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
 * covered, in proportion to how much of each it covered — from the UNDISCOUNTED
 * bases of the units the scope matched.
 *
 * A scope is not a category: `addOns` covers the socks row and every add-on
 * row, and an add-on carrying a `taxCategoryOverride` puts its money somewhere
 * else entirely (the seeded refillable cup is `fnb`). So the split is taken
 * from the units the scope matched, not from the scope's name. An empty result
 * means the scope matched nothing, and the caller treats the discount as
 * order-wide rather than inventing a category for it.
 */
function categoryBasesOf(units: readonly CartUnit[]): Map<TaxableCategory, Satang> {
  const bases = new Map<TaxableCategory, Satang>();
  for (const unit of units) {
    bases.set(unit.category, (bases.get(unit.category) ?? 0) + unit.base);
  }
  return bases;
}

/**
 * Whether one unit is inside a promo's scope.
 *
 * A breakdown row answers through `rowMatchesTarget`, unchanged. The two units
 * that are not rows answer here, and both answers are new with ruling 1:
 *
 *   - A FREE-ITEM PROMO'S ITEM is an item, so it answers to item scopes: the
 *     seeded ice-cream code already carries `menuItems: ['m-icecream']`, which
 *     is the catalogue saying where its discount belongs. `fnb` and `merch`
 *     match the kind. `fnbCategory` cannot be answered here — a promo line
 *     carries the item's id and kind but not its menu category — so it returns
 *     false rather than guessing, and a caller wanting that scope has to put
 *     the category on the line.
 *   - PREPAID FOOD answers only to `everything`. It is money in the bill that
 *     no item- or ticket-scoped code was aimed at.
 *
 * `everything` is true for every unit, as `rowMatchesTarget` is for every row.
 * Its only caller short-circuits that scope before getting here — an order-wide
 * code resolves against the whole order and is attributed order-wide — so the
 * answer is unreachable today; it is written as true because "the order-wide
 * scope covers nothing" is the one answer that is wrong in plain English and
 * the easiest for a later caller to mistake for a real empty result.
 */
function unitMatchesTarget(unit: CartUnit, target: DiscountTarget, socksAddOnId: string): boolean {
  if (unit.row) return rowMatchesTarget(unit.row, unit.packageId, target, socksAddOnId);
  if (unit.promoItem) {
    const item = unit.promoItem;
    switch (target.kind) {
      case 'everything':
        return true;
      case 'menuItems':
        return item.itemKind === 'menu' && target.menuItemIds.includes(item.itemId);
      case 'fnb':
        return item.itemKind === 'menu';
      case 'merch':
        return item.itemKind === 'merch';
      default:
        return false;
    }
  }
  return target.kind === 'everything'; // prepaid food
}

/**
 * WHAT EACH UNIT HAS LEFT TO BE DISCOUNTED — the AMOUNT ledger.
 *
 * THIS IS NOT THE ATTRIBUTION LEDGER, and the two must not be confused. The
 * `remaining` map in `computeTicketCartTotals` answers "which taxable category
 * absorbs this discount"; this one answers "how much may this discount take at
 * all". A change to the attribution line was made on 2026-09-20 and reverted
 * the same day because it overcharged the guest on 2,528 of 2,528 divergences
 * in a 20,000-cart differential run (see the attribution note above, and
 * EC-17). This ledger is the other line.
 */
interface LedgerEntry {
  unit: CartUnit;
  remaining: Satang;
}

/**
 * Take `amount` out of a scope, in proportion to what each of its units has
 * left. Clamped per unit, and a no-op for a non-positive amount — a promo
 * stored with a negative value is a surcharge nobody charges (EC-23), and it
 * must not put money BACK into a scope.
 */
function spendScope(entries: readonly LedgerEntry[], amount: Satang): Satang[] {
  // What was taken from each entry, index for index with `entries`: the caller
  // of a line-aimed promo reports it (`AppliedPromo.units`); the others ignore it.
  const taken = entries.map(() => 0);
  if (amount <= 0) return taken;
  const live = entries.filter((entry) => entry.remaining > 0);
  if (live.length === 0) return taken;
  const capacity = live.reduce((sum, entry) => sum + entry.remaining, 0);
  const spend = Math.min(amount, capacity);
  // Largest remainder, for the same reason as everywhere else: whole satang
  // that sum back to what was spent.
  const shares =
    live.length === 1
      ? [spend]
      : apportion(
          spend,
          live.map((entry) => entry.remaining),
        );
  live.forEach((entry, index) => {
    const take = Math.min(entry.remaining, shares[index] ?? 0);
    entry.remaining -= take;
    taken[entries.indexOf(entry)] = take;
  });
  return taken;
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

/**
 * S2-10b — A PROMO AIMED AT ONE LINE of the cart, and — when `component` is set
 * — at one component of that line (its kids row, say), rather than at a class
 * of rows.
 *
 * WHY A SCOPE NEEDS THIS. Every other scope names a KIND of thing — tickets,
 * a package's tickets, a menu item — and matches every row of that kind on
 * the cart. That is right for a code ("10 % off food") and wrong for a thing
 * that belongs to one line: a voucher's free pizza is the pizza the voucher put
 * on the bill, not every pizza, and a 1+1's free ticket is one kid's ticket, not
 * a share of every ticket of that package, adults included. Aimed at the line,
 * the markdown is bounded by that line alone (ruling 2 still holds: it takes no
 * more than the line has left), attributed to that line's category, and
 * reported per unit so a ledger can book it on that line (`AppliedPromo.units`).
 *
 * The same shape a manual discount already uses to name its target
 * (`ManualDiscount.targetLineId` / `targetComponent`), and resolved by the same
 * rule (`lineScope` in `computeTicketCartTotals`).
 */
export interface PromoLineTarget {
  lineId: string;
  component?: DiscountComponentTarget;
}

/** A promo as the totals take it: any `PromoDiscount`, optionally aimed at one line. */
export type CartPromo = PromoDiscount & { line?: PromoLineTarget };

/** What one applied promo code took off the order. */
export interface AppliedPromo {
  code: string;
  label: string;
  type: PromoDiscount['type'];
  amount: Satang;
  /**
   * Set when the code found NOTHING LEFT IN ITS OWN SCOPE to discount, so it
   * took nothing — the visible half of ruling 2. Without it a code that spends
   * zero looks identical on the receipt to one nobody scanned, and reception
   * has no answer for a guest asking why their code did nothing.
   *
   * The wording is the promo vocabulary's own (`promoNotApplicableReason`), the
   * same sentence `validatePromoCode` shows when a code matches nothing at
   * scan time. It is the same fact one step later: at scan time the scope was
   * empty, here it has been emptied by the discounts already on the cart.
   */
  exhaustedReason?: string;
  /**
   * S2-10b — set only on a promo aimed at one line (`CartPromo.line`): what it
   * took from each unit it reached, by the unit's index in
   * `cartUnits(lines, ctx)` for the same lines and context. A sale ledger that
   * writes one row per unit books the markdown on those rows rather than
   * spreading it across the category (`buildPricedLines` in the api).
   */
  units?: { index: number; amount: Satang }[];
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
 * So S2-13 picked one, and it is a decision, not a patch: either carry
 * `lengthChosen` onto the line and exempt an unpriced drop-off line here the
 * way promo lines are exempt, or keep unpriced lines out of the cart that is
 * totalled until the length is chosen. What it must NOT do is reach for
 * `staleLines: 'trust_stored'` — that is a diagnostic, it re-derives every tax
 * base from `ctx` anyway, and on an unpriced line it would charge the guest for
 * play time the till is showing as ฿0.
 *
 * SETTLED (S2-13, plan docs/progress/plans/checkin/PLAN.md §2.2): the second.
 * A drop-off line ENTERS the cart only once its length is chosen
 * (`dropOffLineEntersCart` in `supervision.ts`); until then it is on the
 * till's screen and in no quote and no sale — the till's sale payload builder
 * (`apps/pos/src/api/sales.ts`, `buildCartPayload`) leaves it out, and the
 * platform is not asked to quote while one is on screen (`unquotableReason`).
 * The till's own on-screen total still re-derives it at ฿0 and names it
 * stale, which is display, not a price. This function is therefore unchanged
 * and still refuses every stale line it is handed — the platform is never
 * handed an unpriced drop-off line.
 *
 * AND THE LARGER POINT, FOR WHOEVER BUILDS THE CART (S2-09a), so it is not
 * rediscovered: RULINGS 3 AND 4 DECIDE WHICH DATE IS READ, BUT WHAT ACTUALLY
 * PROTECTS THE MONEY IS THE FREEZE. A price and a code's validity are resolved
 * ONCE, when the line goes into the cart, and stored on the sale — never
 * recalculated. A cart open across 05:00 must not silently re-price itself, and
 * a code scanned at 04:55 must not stop being valid at 04:56 while the guest is
 * still at the till.
 *
 * This function is the first half of that: it REFUSES a cart whose stored line
 * totals were not priced under the context it is being totalled with, so the
 * drift is a loud error rather than a receipt that does not add up. The cart
 * has to supply the other three halves, none of which lives here:
 *   1. snapshot the rate mode (and the instant it came from) onto the cart when
 *      the first line is added, and total with THAT context, not with a fresh
 *      `rateModeToday`;
 *   2. snapshot each applied code's validity decision — `validatePromoCode`
 *      runs at scan time and its answer is what the sale records, so the date
 *      it was judged against is frozen with it;
 *   3. when the snapshot and the clock disagree, tell staff and let them
 *      re-price deliberately (`repriceCartLines`), because re-pricing a cart a
 *      guest has already been quoted is a decision a person makes.
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
  promos: readonly CartPromo[],
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
  for (const line of lines) {
    lineAmounts[line.id] = line.lineTotal;
    componentBases[line.id] = lineComponentBases(line, ctx);
  }
  const manual = computeManualDiscount(
    manualDiscounts,
    subtotal,
    lineAmounts,
    componentBases,
    rounding,
  );

  // THE TWO LEDGERS, threaded through every discount in order. Keep them apart:
  //   `ledger`    — how much each unit has LEFT TO BE DISCOUNTED. It bounds the
  //                 AMOUNT a scoped discount may take (ruling 2).
  //   `remaining` — how much of each taxable category is left to ABSORB a
  //                 discount. It decides which category books it, never how big
  //                 it is (the attribution note above, and EC-17).
  const units = cartUnits(lines, ctx);
  const ledger: LedgerEntry[] = units.map((unit) => ({ unit, remaining: unit.base }));
  const remaining = new Map<TaxableCategory, Satang>();
  for (const input of ticketCartTaxInputs(lines, ctx)) {
    remaining.set(input.category, (remaining.get(input.category) ?? 0) + input.base);
  }
  const entriesOfLine = (lineId: string): LedgerEntry[] =>
    ledger.filter((entry) => entry.unit.lineId === lineId);

  /** The units of one line, or of one component of it — a manual discount's target, or a line-aimed promo's. */
  const lineScope = (lineId: string, component?: DiscountComponentTarget): LedgerEntry[] => {
    const entries = entriesOfLine(lineId);
    if (!component) return entries;
    const wanted = componentKey(component);
    return entries.filter(
      (entry) => entry.unit.row !== null && breakdownComponentKey(entry.unit.row) === wanted,
    );
  };

  /** The units one manual discount is aimed at: the order, a line, or one of its components. */
  const scopeOfManual = (discount: ManualDiscount): LedgerEntry[] => {
    if (discount.scope !== 'line' || !discount.targetLineId) return ledger;
    return lineScope(discount.targetLineId, discount.targetComponent);
  };

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
  const allocations: DiscountAllocation[] = [];
  for (const discount of manualDiscounts) {
    const amount = manual.amounts[discount.id] ?? 0;
    if (amount <= 0) continue;
    const scope = scopeOfManual(discount);
    // It has spent its scope, so a promo code aimed at the same items finds
    // that much less of them. An order-scope discount spends the whole cart
    // proportionally, which is how `computeTaxBreakdown` spreads an order-wide
    // allocation, so the two ledgers stay in step.
    spendScope(scope, amount);
    if (discount.scope !== 'line' || !discount.targetLineId) {
      allocations.push({ amount }); // order scope — genuinely order-wide
      continue;
    }
    // An empty scope (the line was removed) yields no category bases, and
    // `allocateAgainstRemaining` turns that into one order-wide allocation.
    const bases = categoryBasesOf(scope.map((entry) => entry.unit));
    allocations.push(...allocateAgainstRemaining(amount, bases, remaining));
  }

  // Manual discounts come off first; codes apply to what remains. Several
  // stackable codes apply SEQUENTIALLY, each against the balance the previous
  // one left, so the order can never go negative.
  //
  // RULING 2, 2026-09-20, AND IT IS A DECISION OF OURS, NOT A RULE WE FOUND.
  // Nothing in this repository says whether one discount may spend twice on the
  // same items. Until this ruling a scoped code was clamped only by the
  // ORDER-level running balance, with its base read off the UNDISCOUNTED
  // breakdown — so a line comped to zero and then a ticket-scoped code
  // discounted the same tickets again, and ฿1,000 of add-ons walked out free
  // (EC-15). A scoped code now takes no more than its OWN SCOPE has left.
  //
  // THE REASONING, recorded because it is ours:
  //   - There is no manager approval on discounts anywhere in this system, by
  //     design (R-08; the backend logic doc §16/§20 remove the approval gates).
  //     The arithmetic is therefore the only thing between a scoped code and
  //     the stockroom.
  //   - Two neighbouring systems already track what a line has left — staff
  //     benefits (`benefits.ts:107-131`) and manual discounts themselves
  //     (`computeManualDiscount`). This follows the park's own pattern rather
  //     than inventing one.
  //   - Without it the same two discounts applied in the opposite order produce
  //     different bills, which reception cannot explain to a guest.
  //
  // IT MOVES MONEY, upward, and that is the point rather than a side effect:
  // EC-15 goes from 0 to 100000 and EC-17 from 0 to 30000. Both notes say so.
  let running = subtotal - manual.total;
  let promoDiscountTotal = 0;
  const appliedPromos: AppliedPromo[] = [];
  for (const promo of promos) {
    const target = promo.target ?? { kind: 'everything' as const };
    // S2-10b — a promo aimed at one line takes its scope from that line and
    // nothing else, whatever its type or target says (`PromoLineTarget`).
    const aimed = promo.line ? lineScope(promo.line.lineId, promo.line.component) : null;
    // A FREE-ITEM CODE'S SCOPE IS THE LINE IT PUT THERE, always — the id is the
    // one the till mints (`freeItemLineId`), which is already how removing the
    // code removes the line. Ruling 1 is that the item goes on at ฿0 and the
    // rest of the bill is untouched, so the offsetting discount belongs to that
    // item whatever the stored `target` says; the seeded code's own
    // `menuItems: ['m-icecream']` agrees, and a code configured with no target
    // or the wrong one would otherwise book the markdown against the tickets.
    // This is what replaced the old `type === 'free_item'` special case, which
    // resolved the code against the ORDER balance and attributed it order-wide.
    const orderWide = !aimed && promo.type !== 'free_item' && target.kind === 'everything';
    const scope =
      aimed ??
      (promo.type === 'free_item'
        ? entriesOfLine(freeItemLineId(promo.code))
        : orderWide
          ? ledger
          : ledger.filter((entry) => unitMatchesTarget(entry.unit, target, ctx.socks.addOnId)));
    const scopeLeft = scope.reduce((sum, entry) => sum + entry.remaining, 0);
    // An order-wide code is resolved against the order balance, which is the
    // prototype's arithmetic and includes money no unit-scope reaches.
    const base = orderWide ? running : Math.min(scopeLeft, running);
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
    const taken = spendScope(scope, amount);
    appliedPromos.push({
      code: promo.code,
      label: promo.label,
      type: promo.type,
      amount,
      ...(base <= 0 ? { exhaustedReason: promoNotApplicableReason(promo.code) } : {}),
      ...(aimed
        ? {
            units: aimed
              .map((entry, index) => ({ index: ledger.indexOf(entry), amount: taken[index] ?? 0 }))
              .filter((unit) => unit.amount > 0),
          }
        : {}),
    });
    if (orderWide) {
      if (amount > 0) allocations.push({ amount });
    } else {
      // A free-item code's line now carries a taxable base of its own — the
      // item's, in the item's category — so the discount that offsets it lands
      // there: F&B gross ฿50, markdown ฿50, net 0 (WE-8).
      allocations.push(
        ...allocateAgainstRemaining(
          amount,
          categoryBasesOf(scope.map((entry) => entry.unit)),
          remaining,
        ),
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
