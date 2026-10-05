import type { Satang } from './money';
import type { RoundingPolicy } from './rounding';
import { PROTOTYPE_BAHT_ROUNDING, roundToPolicy } from './rounding';
import type {
  DiscountComponentTarget,
  LineBreakdownItem,
  PricingContext,
  TicketCartLine,
} from './pricing';
import {
  componentKey,
  computeLineBreakdown,
  lineComponentBases,
  SERVICE_FEE_ROW_KEY,
} from './pricing';

/**
 * Discounts — a port of the prototype's `lib/manualDiscount.ts` and
 * `lib/discountTarget.ts`, in satang.
 *
 * THE ORDER IS THE LOAD-BEARING RULE and it lives in `computeTicketCartTotals`
 * (cart-totals.ts): manual discounts first, all of them, then promo codes
 * sequentially against what remains. Reversing it moves the total — on the
 * worked example WE-6 by ฿20 on a ฿2,130 bill.
 *
 * THE TWO PLACES IT DELIBERATELY DIVERGES FROM THE PROTOTYPE, named here
 * because "faithful port" in a file header is what a later reader trusts:
 *
 *   1. `rowMatchesTarget` answers TRUE for the `everything` scope, where the
 *      prototype's `rowMatches` explicitly returns false
 *      (lib/discountTarget.ts:32, :65-66). See the note on that function for
 *      why, and for what a caller porting prototype logic has to know.
 *   2. `computeManualDiscount` REFUSES a repeated discount id, which the
 *      prototype silently accepts (and mis-totals — see that function).
 *
 * Everything else here is the prototype's arithmetic, its clamps and its edge
 * cases, with money in satang and the rounding unit made a policy argument.
 */

/**
 * A staff-applied discount with a reason. Pushed to the activity log and a
 * "discounts given" report, attributed to the operator who applied it.
 *
 * WHAT THE ENGINE READS, and it is only this: `id`, `scope`, `targetLineId`,
 * `targetComponent`, `type`, `value`. The rest travels with the discount so
 * that the one object the till holds is the one the sale record stores; see
 * `ManualDiscountRecord` for the fields that are written at sale time and are
 * never inputs to a price.
 *
 * Port of prototype `ManualDiscount` (types.ts:443-459).
 */
export interface ManualDiscount {
  /**
   * Unique within one cart. It keys `ManualDiscountResult.amounts`, the row a
   * receipt prints and the row the sale record writes, so two discounts sharing
   * one id are not representable — `computeManualDiscount` refuses them rather
   * than let one silently overwrite the other.
   */
  id: string;
  scope: 'order' | 'line';
  /** Set when scope === 'line'. */
  targetLineId?: string;
  /** Set when a single component of the line is targeted; absent = the whole line. */
  targetComponent?: DiscountComponentTarget;
  /**
   * Human label of the targeted item or component ("Kids", "Locker Rental"),
   * for the receipt and the discount list. Display only — the engine resolves
   * the target from `targetLineId` / `targetComponent`, never from this.
   */
  targetLabel?: string;
  /** comp = 100 % off the target. */
  type: 'percent' | 'fixed' | 'comp';
  /** A percentage for 'percent'; SATANG for 'fixed'; ignored for 'comp'. */
  value: number;
  /**
   * Why staff applied it. REQUIRED, as in the prototype, because a discount
   * with no reason is exactly what the "discounts given" report exists to stop;
   * S2-09a's acceptance criteria say "a manual fixed discount with reason".
   *
   * The choices are branch-editable data, not an enum here: the prototype seeds
   * seven ("Service recovery", "Staff / family", "Damaged item", "Manager
   * comp", "Promotion", "Loyalty", "Other" — store/catalogStore.ts:318-326) and
   * an admin screen edits the list. The engine never reads it.
   */
  reason: string;
  /** Optional free text alongside the reason. The engine never reads it. */
  note?: string;
}

/**
 * A manual discount AS THE SALE RECORD STORES IT — what S2-09b writes, not what
 * the engine prices with.
 *
 * The split matters because these four fields are answers to "who did this, and
 * what did it come to at the time", and the engine cannot supply any of them:
 * it has no clock (engine.ts) and no session. The till supplies them when the
 * sale is written, from the session that made the change.
 *
 * `amount` is the prototype's `amountTHB` in satang: a SNAPSHOT of what the
 * discount resolved to on the cart as it stood, kept for audit while the live
 * totals recompute from `value` on every edit (POS_RULES_RECONCILIATION.md
 * R-28, C18). Take it from `ManualDiscountResult.amounts[id]` at the moment the
 * sale is committed — never re-derive it later against a different cart.
 */
export interface ManualDiscountRecord extends ManualDiscount {
  /** SATANG the discount resolved to when the sale was committed. */
  amount: Satang;
  /** The operator's name, for the receipt and the report. */
  appliedBy: string;
  /** The account id the audit row is attributed to. */
  appliedById: string;
  /** ISO 8601 instant, taken from the caller's one clock read. */
  appliedAt: string;
}

/**
 * Resolve one manual discount against a base.
 *
 * `comp` takes the whole base; `fixed` is clamped to it; `percent` is clamped
 * to 0–100 first, then rounded. A zero or negative base yields 0 — that guard
 * is what stops a stacked discount from turning into a credit.
 *
 * Manual percentages round to whole baht, as `lib/manualDiscount.ts:11`:
 * 10 % of ฿973 is ฿97. Fixed amounts and comps retain their satang amounts.
 */
export function resolveManualDiscountAmount(
  discount: ManualDiscount,
  base: Satang,
  rounding: RoundingPolicy = PROTOTYPE_BAHT_ROUNDING,
): Satang {
  if (base <= 0) return 0;
  if (discount.type === 'comp') return base;
  if (discount.type === 'fixed') return Math.min(Math.max(0, discount.value), base);
  const percent = Math.max(0, Math.min(100, discount.value));
  return Math.min(base, roundToPolicy((base * percent) / 100, rounding));
}

export interface ManualDiscountResult {
  /** Resolved satang amount per discount id — what the audit row records. */
  amounts: Record<string, Satang>;
  lineTotal: Satang;
  orderTotal: Satang;
  total: Satang;
}

/**
 * Compute manual-discount amounts. Line-scope discounts run first in array
 * order and reduce their own line; order-scope discounts then run in array
 * order against the subtotal less all the line-scope ones, each against what
 * the previous left.
 *
 * A line-scope discount may target one component (kids, adults, socks, one
 * add-on) and then resolves against that component's remaining base, but is
 * still clamped to the line's remaining total so a line can never go negative
 * when component and whole-line discounts stack. Port of prototype
 * `computeManualDiscount` (lib/manualDiscount.ts:35).
 *
 * IT REFUSES A REPEATED ID, and that is the one behavioural divergence from the
 * prototype in this function. `amounts` is keyed by id and the prototype's last
 * write wins (`amounts[d.id] = amt`, lib/manualDiscount.ts:71 and :82), so two
 * discounts sharing an id collapse into one entry while BOTH are counted in
 * `total`. The prototype survives that because it hands the tax cascade a
 * single `manual.total`; the port hands it one allocation per discount, read
 * back out of `amounts` by id (cart-totals.ts), so the collapsed entry is
 * counted twice and the other is never placed at all.
 *
 * MEASURED, on the one-line 109000 cart of fixture MD-2 with two discounts both
 * carrying id 'dup' — 30000 on the kids and 5000 on the socks: the cart reports
 * 35000 of discount, the cascade receives 10000 (the socks amount, placed
 * twice), and the guest is charged 99000 instead of 74000. ฿250 of discount
 * vanishes, against the guest, with `unappliedDiscount` reporting 0.
 *
 * REFUSING RATHER THAN REPAIRING, because the amounts map cannot represent the
 * cart either way: make the attribution index-based and the total is right
 * again, but `amounts` still has one entry for two discounts, so the receipt
 * row, the "discounts given" report and the sale record S2-09b writes are all
 * wrong by one discount. An id that is not unique is a caller defect — S2-09b
 * mints them on the box — and the fix belongs where the id is minted. A loud
 * refusal at the till is recoverable; a silent overcharge on a printed receipt
 * is not.
 */
export function computeManualDiscount(
  manualDiscounts: readonly ManualDiscount[],
  subtotal: Satang,
  lineAmounts: Record<string, Satang>,
  componentBases: Record<string, Record<string, Satang>> = {},
  rounding: RoundingPolicy = PROTOTYPE_BAHT_ROUNDING,
): ManualDiscountResult {
  const duplicate = findDuplicateDiscountId(manualDiscounts);
  if (duplicate !== null) {
    throw new Error(
      `Manual discounts must carry distinct ids; "${duplicate}" appears more than once. ` +
        `Each id keys one amount, one receipt row and one audit row.`,
    );
  }

  const amounts: Record<string, Satang> = {};

  // Per-line running state, built lazily as discounts reference each line.
  const lineRemaining: Record<string, Satang> = {};
  const compRemaining: Record<string, Record<string, Satang>> = {};

  let lineTotal = 0;
  for (const discount of manualDiscounts) {
    if (discount.scope !== 'line' || !discount.targetLineId) continue;
    const lineId = discount.targetLineId;
    if (!(lineId in lineRemaining)) {
      lineRemaining[lineId] = lineAmounts[lineId] ?? 0;
      compRemaining[lineId] = { ...(componentBases[lineId] ?? {}) };
    }
    const remaining = lineRemaining[lineId] ?? 0;
    const components = compRemaining[lineId] ?? {};

    let base = remaining;
    let key: string | null = null;
    if (discount.targetComponent) {
      key = componentKey(discount.targetComponent);
      base = components[key] ?? 0;
    }

    let amount = resolveManualDiscountAmount(discount, base, rounding);
    if (amount > remaining) amount = remaining;
    if (amount < 0) amount = 0;

    amounts[discount.id] = amount;
    lineTotal += amount;
    lineRemaining[lineId] = remaining - amount;
    if (key) components[key] = base - amount;
  }

  let running = subtotal - lineTotal;
  let orderTotal = 0;
  for (const discount of manualDiscounts) {
    if (discount.scope !== 'order') continue;
    const amount = resolveManualDiscountAmount(discount, running, rounding);
    amounts[discount.id] = amount;
    orderTotal += amount;
    running -= amount;
  }

  return { amounts, lineTotal, orderTotal, total: lineTotal + orderTotal };
}

/**
 * The first id that appears twice, or null. Exported so a till can check a
 * discount before it is added — refusing at the "Add discount" button is a
 * better place to find this than at the total.
 */
export function findDuplicateDiscountId(discounts: readonly ManualDiscount[]): string | null {
  const seen = new Set<string>();
  for (const discount of discounts) {
    if (seen.has(discount.id)) return discount.id;
    seen.add(discount.id);
  }
  return null;
}

/**
 * Drop manual discounts that lost their target: a line-scope one whose line was
 * removed, and a component-scope one whose component fell to zero (kids reduced
 * to 0, an add-on removed). Call after any cart edit. Port of prototype
 * `dropOrphanedDiscounts` (lib/manualDiscount.ts:123).
 */
export function dropOrphanedDiscounts(
  discounts: readonly ManualDiscount[],
  lines: readonly TicketCartLine[],
  ctx: PricingContext,
): ManualDiscount[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  return discounts.filter((discount) => {
    if (!discount.targetLineId) return true; // order scope — never orphaned by a line
    const line = byId.get(discount.targetLineId);
    if (!line) return false;
    if (!discount.targetComponent) return true;
    const bases = lineComponentBases(line, ctx);
    return (bases[componentKey(discount.targetComponent)] ?? 0) > 0;
  });
}

// --- Promo-code scoping -----------------------------------------------------

/**
 * What a promo code applies to. Absent on a promo means the whole order.
 *
 * One vocabulary serves every register. Since S2-09b a cart can hold food and
 * shop lines beside admission, so `fnb`, `fnbCategory`, `menuItems` and `merch`
 * match the item rows on it (SCRUM-344); on a cart of nothing but tickets they
 * still match nothing, and `event_pass` matches nothing anywhere until a
 * register sells one.
 */
export type DiscountTarget =
  | { kind: 'everything' }
  | { kind: 'tickets' }
  | { kind: 'ticketGroup'; group: 'kids' | 'adults' }
  | { kind: 'ticketType'; ticketTypeId: string }
  | { kind: 'addOns' }
  | { kind: 'addOn'; addOnId: string }
  | { kind: 'fnb' }
  | { kind: 'fnbCategory'; category: string }
  | { kind: 'menuItems'; menuItemIds: string[] }
  | { kind: 'merch' }
  | { kind: 'event_pass' };

/**
 * Whether one rendered breakdown row falls inside a promo's scope. Exported
 * because `cart-totals.ts` has to walk the same rows a second time to work out
 * WHICH TAXABLE CATEGORIES a scoped discount landed in — a scope like `addOns`
 * can span more than one category once an add-on carries a
 * `taxCategoryOverride`, so the attribution cannot be read off the target kind.
 *
 * THIS DIVERGES FROM THE PROTOTYPE ON ONE SCOPE, AND IT IS THE OPPOSITE ANSWER.
 * `everything` returns TRUE here for every row; the prototype's `rowMatches`
 * lists `everything` alongside the F&B scopes and returns FALSE
 * (lib/discountTarget.ts:32, :65-66). A caller porting prototype code must know
 * which of the two it is calling.
 *
 * WHY THE PORT ANSWERS DIFFERENTLY. In the prototype that `false` is
 * unreachable: `discountTargetBase` returns the sum of line totals for
 * `everything` before the row walk begins (lib/discountTarget.ts:17-18), so
 * `rowMatches` is never asked about it, and the value there is arbitrary. This
 * function is exported and this package has a second caller
 * (`categoryBasesForTarget`), so the value is no longer arbitrary: `false` for
 * every row would say "the order-wide scope covers nothing", which is the one
 * answer that is wrong in plain English and the easiest to mistake for a real
 * empty result.
 *
 * Both callers in this package still short-circuit `everything` before they
 * reach here, and are right to: an order-wide code resolves against the sum of
 * LINE TOTALS (which includes a promo line and prepaid food, neither of which
 * is a breakdown row) and is attributed order-wide rather than per category.
 *
 * SCRUM-344 — IT NOW ANSWERS FOR AN F&B OR SHOP ITEM ROW TOO, and the two
 * answers it used to give about one were both wrong:
 *
 *   - `fnb`, `fnbCategory`, `menuItems` and `merch` returned `false` for every
 *     row, on the reasoning that food and merchandise are "sold at other
 *     registers". Since S2-09b they are sold through this cart: an item line
 *     reaches the engine as one catalogue item on its own line, carrying
 *     `itemKind` and its category walk (`CartAddOn`). A code scoped to food
 *     found no base to reduce and took nothing off the guest's bill.
 *   - `addOns` returned `true` for it, because an item row borrows the `addon`
 *     kind the way the drop-off service fee does. A code scoped to ticket
 *     add-ons therefore discounted a latte.
 *
 * So the item rows are excluded from the add-on scopes by the same predicate
 * that already excludes the service fee, and answered on the item scopes by the
 * prototype's own rules for a menu item (`menuItemMatchesTarget`,
 * `apps/pos/src/lib/discountTarget.ts:79-104`): `fnb` matches any menu item,
 * `fnbCategory` matches the item's own category or its parent, `menuItems`
 * matches by id. A merch row answers only to `merch`, which is the same split
 * `unitMatchesTarget` already applies to a free-item promo's item in
 * `cart-totals.ts` — `menuItems` and `fnb` are the menu's, `merch` is the
 * shop's. `event_pass` still matches nothing: no register sells one yet.
 */
export function rowMatchesTarget(
  row: LineBreakdownItem,
  packageId: string,
  target: DiscountTarget,
  socksAddOnId: string,
): boolean {
  const isTicket = row.kind === 'kids' || row.kind === 'adults';
  // An F&B or shop line rides in on the `addon` kind (see the note above), so
  // every "is this a ticket add-on" question has to exclude it by name — the
  // same way it excludes the drop-off service fee.
  const isItem = row.itemKind !== undefined;
  // A real add-on row, or the socks row (socks are an add-on) — but never the
  // drop-off service fee, which borrows the 'addon' kind, and never a food or
  // shop item, which borrows it too.
  const isAddOn =
    row.kind === 'socks' ||
    (row.kind === 'addon' && row.key !== SERVICE_FEE_ROW_KEY && !isItem);

  switch (target.kind) {
    case 'tickets':
      return isTicket;
    case 'ticketGroup':
      return row.kind === target.group;
    case 'ticketType':
      return isTicket && packageId === target.ticketTypeId;
    case 'addOns':
      return isAddOn;
    case 'addOn':
      return (
        (row.kind === 'addon' && !isItem && row.key === target.addOnId) ||
        (row.kind === 'socks' && target.addOnId === socksAddOnId)
      );
    case 'everything':
      // Every row is inside "everything" — the prototype says false here and
      // never asks; see the note above on the divergence and on why both
      // callers in this package short-circuit the scope rather than walk rows.
      return true;
    case 'fnb':
      return row.itemKind === 'menu';
    case 'fnbCategory':
      // The walk the row carries: its own category, then its parent. A menu
      // item filed under no category at all matches no category scope.
      return row.itemKind === 'menu' && (row.categoryIds ?? []).includes(target.category);
    case 'menuItems':
      // The row's key is the catalogue item's id, which is what a `menuItems`
      // scope names (`computeLineBreakdown` keys an add-on row on `addOn.id`).
      return row.itemKind === 'menu' && target.menuItemIds.includes(row.key);
    case 'merch':
      return row.itemKind === 'merch';
    // No register sells an event pass through this cart yet, so a code scoped
    // to one still finds no base to reduce.
    case 'event_pass':
      return false;
  }
}

/**
 * The satang subtotal of a ticket cart that falls within a promo's scope. Port
 * of prototype `discountTargetBase` (lib/discountTarget.ts:13).
 */
export function discountTargetBase(
  lines: readonly TicketCartLine[],
  target: DiscountTarget,
  ctx: PricingContext,
): Satang {
  // Deliberately NOT the row walk below: an order-wide code applies to the sum
  // of line totals, which includes a free-item promo line and prepaid food —
  // money that is in the bill but is not a breakdown row (prototype
  // lib/discountTarget.ts:17-18).
  if (target.kind === 'everything') {
    return lines.reduce((acc, line) => acc + line.lineTotal, 0);
  }
  let base = 0;
  for (const line of lines) {
    for (const row of computeLineBreakdown(line, ctx)) {
      if (rowMatchesTarget(row, line.packageId, target, ctx.socks.addOnId)) base += row.subtotal;
    }
  }
  return base;
}
