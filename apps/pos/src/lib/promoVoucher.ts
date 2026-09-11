import type { Discount, CartLine } from '@/types';
import { discountTargetBase } from '@/lib/discountTarget';
import { getMenuItems, getMerchItems } from '@/store/catalogStore';
import { resolveRateToday } from '@/lib/pricingMode';

/**
 * Result of validating a promo code at checkout.
 * ok=true  → the promo is valid and may be applied.
 * ok=false → a specific rejection reason to show to staff.
 */
export type PromoValidation =
  | { ok: true; promo: Discount }
  | { ok: false; reason: string };

/**
 * Validate a promo code against the current cart and customer before applying it.
 * Checks: active flag, date window, total-usage limit, per-customer limit, and
 * whether the code's target scope actually matches something in the cart.
 *
 * @param promo            The promo fetched from the catalog.
 * @param lines            Current cart lines (for applicability check).
 * @param today            ISO date YYYY-MM-DD (caller provides to keep this pure).
 * @param customerPhone    Optional — used for per-customer limit enforcement.
 * @param appliedDiscounts Codes already on the cart (for stacking rules).
 */
export function validatePromoCode(
  promo: Discount,
  lines: CartLine[],
  today: string,
  customerPhone?: string,
  appliedDiscounts: Discount[] = [],
): PromoValidation {
  // 0. Already applied? Codes are unique per cart.
  if (appliedDiscounts.some((d) => d.code.toUpperCase() === promo.code.toUpperCase())) {
    return { ok: false, reason: `Code "${promo.code}" is already applied.` };
  }

  // 0b. Stacking rules — a second code is only allowed when EVERY code (the
  //     ones already on the cart AND this one) is explicitly stackable.
  if (appliedDiscounts.length > 0) {
    if (!promo.stackable) {
      return {
        ok: false,
        reason: `Code "${promo.code}" can't be combined with other codes.`,
      };
    }
    const blocker = appliedDiscounts.find((d) => !d.stackable);
    if (blocker) {
      return {
        ok: false,
        reason: `Code "${blocker.code}" can't be combined with other codes — remove it first.`,
      };
    }
  }

  // 1. Active flag
  if (promo.active === false) {
    return { ok: false, reason: `Code "${promo.code}" is not currently active.` };
  }

  // 2. Validity window
  if (promo.validFrom && today < promo.validFrom) {
    return {
      ok: false,
      reason: `Code "${promo.code}" is not valid until ${fmtDate(promo.validFrom)}.`,
    };
  }
  if (promo.validUntil && today > promo.validUntil) {
    return {
      ok: false,
      reason: `Code "${promo.code}" expired on ${fmtDate(promo.validUntil)}.`,
    };
  }

  // 3. Total usage limit
  if (
    promo.usageLimit !== undefined &&
    (promo.usedCount ?? 0) >= promo.usageLimit
  ) {
    return {
      ok: false,
      reason: `Code "${promo.code}" has reached its total usage limit.`,
    };
  }

  // 4. Per-customer limit (only enforced when phone is known)
  if (promo.perCustomerLimit !== undefined && customerPhone) {
    const usedByCustomer = promo.perCustomerUsage?.[customerPhone] ?? 0;
    if (usedByCustomer >= promo.perCustomerLimit) {
      return {
        ok: false,
        reason: `This code can only be used ${promo.perCustomerLimit === 1 ? 'once' : `${promo.perCustomerLimit} times`} per customer.`,
      };
    }
  }

  // 5. Applicability to the cart
  //    free_item: requires a non-empty cart AND a resolvable item in the catalog.
  //    percent / fixed: the scoped base must be > 0
  const cartTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  if (promo.type === 'free_item') {
    if (cartTotal <= 0) {
      return {
        ok: false,
        reason: `Code "${promo.code}" requires at least one item in the cart.`,
      };
    }
    // Verify the configured free item still exists in the catalog.
    const item = resolveFreeItem(promo);
    if (!item) {
      return {
        ok: false,
        reason: `Code "${promo.code}" references an item that is no longer available.`,
      };
    }
  } else {
    const target = promo.target ?? { kind: 'everything' as const };
    const base =
      target.kind === 'everything'
        ? cartTotal
        : discountTargetBase(lines, target);
    if (base <= 0) {
      return {
        ok: false,
        reason: `Code "${promo.code}" doesn't apply to any items in this order.`,
      };
    }
  }

  return { ok: true, promo };
}

/**
 * Look up the free item referenced by a free_item promo and return its name
 * and price. Returns null when the item is not found in the catalog.
 */
export function resolveFreeItem(
  promo: Discount,
): { name: string; priceTHB: number } | null {
  if (promo.type !== 'free_item' || !promo.freeItemId) return null;
  const kind = promo.freeItemKind ?? 'menu';
  if (kind === 'merch') {
    const item = getMerchItems().find((m) => m.id === promo.freeItemId);
    return item ? { name: item.name, priceTHB: resolveRateToday(item.price) } : null;
  }
  const item = getMenuItems().find((m) => m.id === promo.freeItemId);
  return item ? { name: item.name, priceTHB: resolveRateToday(item.price) } : null;
}

/**
 * Compute the discount amount (฿) for a free_item promo, given the current cart.
 * For the ticket till this will typically be 0 (F&B items are not in the cart);
 * the amount is the item's catalog price, capped by the cart subtotal so the
 * total never goes negative.
 */
export function freeItemDiscountAmount(
  promo: Discount,
  cartSubtotal: number,
): number {
  const item = resolveFreeItem(promo);
  if (!item) return 0;
  return Math.min(item.priceTHB, cartSubtotal);
}

/** Format an ISO date (YYYY-MM-DD) as a human-readable string. */
function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
