import type { Satang } from './money';
import type { RoundingPolicy } from './rounding';
import { DEFAULT_ROUNDING, roundToPolicy } from './rounding';
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
 * Discounts — a faithful port of the prototype's `lib/manualDiscount.ts` and
 * `lib/discountTarget.ts`, in satang.
 *
 * THE ORDER IS THE LOAD-BEARING RULE and it lives in `computeTicketCartTotals`
 * (cart-totals.ts): manual discounts first, all of them, then promo codes
 * sequentially against what remains. Reversing it moves the total — on the
 * worked example WE-6 by ฿20 on a ฿2,130 bill.
 */

/**
 * A staff-applied discount with a reason. Pushed to the activity log and a
 * "discounts given" report, attributed to the operator who applied it.
 */
export interface ManualDiscount {
  id: string;
  scope: 'order' | 'line';
  /** Set when scope === 'line'. */
  targetLineId?: string;
  /** Set when a single component of the line is targeted; absent = the whole line. */
  targetComponent?: DiscountComponentTarget;
  /** comp = 100 % off the target. */
  type: 'percent' | 'fixed' | 'comp';
  /** A percentage for 'percent'; SATANG for 'fixed'; ignored for 'comp'. */
  value: number;
}

/**
 * Resolve one manual discount against a base.
 *
 * `comp` takes the whole base; `fixed` is clamped to it; `percent` is clamped
 * to 0–100 first, then rounded. A zero or negative base yields 0 — that guard
 * is what stops a stacked discount from turning into a credit.
 *
 * The rounding unit is the only place this diverges from the prototype:
 * `lib/manualDiscount.ts:11` does `Math.round(base * pct/100)` on BAHT, so its
 * 10 % of ฿973 is ฿97. The platform rounds half-up to the satang (฿97.30) per
 * SPRINT_2_PLAN.md "Money and time"; pass PROTOTYPE_BAHT_ROUNDING to get the
 * prototype's figure back.
 */
export function resolveManualDiscountAmount(
  discount: ManualDiscount,
  base: Satang,
  rounding: RoundingPolicy = DEFAULT_ROUNDING,
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
 */
export function computeManualDiscount(
  manualDiscounts: readonly ManualDiscount[],
  subtotal: Satang,
  lineAmounts: Record<string, Satang>,
  componentBases: Record<string, Record<string, Satang>> = {},
  rounding: RoundingPolicy = DEFAULT_ROUNDING,
): ManualDiscountResult {
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
 * F&B, merch and event-pass scopes are here because one vocabulary serves every
 * register; in a ticket cart they simply match nothing.
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
 * `everything` matches EVERY row, which is what the word means. Both callers in
 * this package short-circuit it before they get here and are right to — an
 * order-wide code is resolved against the sum of LINE TOTALS (which includes a
 * promo line and prepaid food, neither of which is a breakdown row) and is
 * attributed order-wide rather than per category. But this function is
 * exported, and returning false for `everything` would hand a third caller a
 * silently empty answer for the one scope that covers the whole cart.
 */
export function rowMatchesTarget(
  row: LineBreakdownItem,
  packageId: string,
  target: DiscountTarget,
  socksAddOnId: string,
): boolean {
  const isTicket = row.kind === 'kids' || row.kind === 'adults';
  // A real add-on row, or the socks row (socks are an add-on) — but never the
  // drop-off service fee, which borrows the 'addon' kind.
  const isAddOn = row.kind === 'socks' || (row.kind === 'addon' && row.key !== SERVICE_FEE_ROW_KEY);

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
        (row.kind === 'addon' && row.key === target.addOnId) ||
        (row.kind === 'socks' && target.addOnId === socksAddOnId)
      );
    case 'everything':
      // Every row is inside "everything". See the note above on why both
      // callers here still short-circuit this scope rather than walking rows.
      return true;
    // F&B, merch and event-pass scopes never match a ticket-cart row — those
    // items are sold at other registers. The code finds no base to reduce.
    case 'fnb':
    case 'fnbCategory':
    case 'menuItems':
    case 'merch':
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
  // lib/discountTarget.ts:14).
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
