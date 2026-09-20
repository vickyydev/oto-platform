import type { Satang } from './money';
import type { PricingContext, TicketCartLine } from './pricing';
import type { DiscountTarget } from './discount';
import { discountTargetBase } from './discount';

/**
 * Promo codes — a faithful port of the prototype's `lib/promoVoucher.ts`
 * (validation) in satang. The sequencing of applied codes lives in
 * cart-totals.ts, with the manual discounts it has to run after.
 */
export interface PromoDiscount {
  code: string;
  label: string;
  /**
   * 'percent' — `value` is a percentage.
   * 'fixed'   — `value` is a satang amount off.
   * 'free_item' — the named item is added to the order at ฿0; `value` carries
   *   the item's resolved shelf price once the till has looked it up.
   */
  type: 'percent' | 'fixed' | 'free_item';
  value: number;
  freeItemId?: string;
  freeItemKind?: 'menu' | 'merch';
  /** Absent = the whole order. */
  target?: DiscountTarget;
  /** yyyy-mm-dd. Before this the code is not yet valid. */
  validFrom?: string;
  /** yyyy-mm-dd. After this the code has expired. */
  validUntil?: string;
  usageLimit?: number;
  usedCount?: number;
  perCustomerLimit?: number;
  perCustomerUsage?: Record<string, number>;
  /** Absent/false = exclusive. Every code on a cart must be stackable to stack. */
  stackable?: boolean;
  /** false = disabled. Absent/true = active. */
  active?: boolean;
}

export type PromoValidation = { ok: true; promo: PromoDiscount } | { ok: false; reason: string };

export interface ValidatePromoOptions {
  customerPhone?: string;
  appliedPromos?: readonly PromoDiscount[];
  /**
   * The resolved free item for a `free_item` code, looked up by the caller.
   * The prototype reads the menu and merch catalogues from its store
   * (`resolveFreeItem`, lib/promoVoucher.ts:137); the engine takes the answer
   * as an argument so it stays pure. `null` means "configured but no longer in
   * the catalogue", which is a distinct refusal.
   */
  freeItem?: { name: string; price: Satang } | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "31 Dec 2026" from a yyyy-mm-dd. The prototype uses
 * `toLocaleDateString(undefined, …)`, which renders differently depending on
 * the host locale — a box and the cloud would print different refusal
 * messages. Formatted from the parts instead so the text is the same
 * everywhere; translation belongs to the i18n layer, not here.
 */
function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  if (year === undefined || month === undefined || day === undefined) return iso;
  const name = MONTHS[Number(month) - 1];
  if (name === undefined) return iso;
  return `${Number(day)} ${name} ${year}`;
}

/**
 * Validate a promo code against a cart before applying it. First failure wins,
 * in the prototype's order: already applied → stacking → active → validFrom →
 * validUntil → total usage limit → per-customer limit → applicability.
 *
 * `today` is supplied by the caller (yyyy-mm-dd) so this stays pure. WHICH date
 * to supply is a live question: the prototype passes
 * `new Date().toISOString().slice(0,10)` — the UTC date — so in Bangkok a code
 * expiring "today" stops working at 07:00 local rather than at closing time.
 * Pass the branch calendar date (`branchToday`) or the business date
 * (`businessDate`) instead; both are better than UTC and the choice between
 * them is recorded as an open question for S2-09a.
 */
export function validatePromoCode(
  promo: PromoDiscount,
  lines: readonly TicketCartLine[],
  today: string,
  ctx: PricingContext,
  options: ValidatePromoOptions = {},
): PromoValidation {
  const appliedPromos = options.appliedPromos ?? [];

  // 0. Codes are unique per cart.
  if (appliedPromos.some((d) => d.code.toUpperCase() === promo.code.toUpperCase())) {
    return { ok: false, reason: `Code "${promo.code}" is already applied.` };
  }

  // 0b. A second code is only allowed when EVERY code — the ones on the cart
  //     and this one — is explicitly stackable.
  if (appliedPromos.length > 0) {
    if (!promo.stackable) {
      return { ok: false, reason: `Code "${promo.code}" can't be combined with other codes.` };
    }
    const blocker = appliedPromos.find((d) => !d.stackable);
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
      reason: `Code "${promo.code}" is not valid until ${formatIsoDate(promo.validFrom)}.`,
    };
  }
  if (promo.validUntil && today > promo.validUntil) {
    return {
      ok: false,
      reason: `Code "${promo.code}" expired on ${formatIsoDate(promo.validUntil)}.`,
    };
  }

  // 3. Total usage limit
  if (promo.usageLimit !== undefined && (promo.usedCount ?? 0) >= promo.usageLimit) {
    return { ok: false, reason: `Code "${promo.code}" has reached its total usage limit.` };
  }

  // 4. Per-customer limit — only enforced when we know who the customer is.
  if (promo.perCustomerLimit !== undefined && options.customerPhone) {
    const used = promo.perCustomerUsage?.[options.customerPhone] ?? 0;
    if (used >= promo.perCustomerLimit) {
      return {
        ok: false,
        reason: `This code can only be used ${
          promo.perCustomerLimit === 1 ? 'once' : `${promo.perCustomerLimit} times`
        } per customer.`,
      };
    }
  }

  // 5. Applicability to the cart.
  const cartTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  if (promo.type === 'free_item') {
    if (cartTotal <= 0) {
      return {
        ok: false,
        reason: `Code "${promo.code}" requires at least one item in the cart.`,
      };
    }
    if (!options.freeItem) {
      return {
        ok: false,
        reason: `Code "${promo.code}" references an item that is no longer available.`,
      };
    }
  } else {
    const target = promo.target ?? { kind: 'everything' as const };
    const base = target.kind === 'everything' ? cartTotal : discountTargetBase(lines, target, ctx);
    if (base <= 0) {
      return {
        ok: false,
        reason: `Code "${promo.code}" doesn't apply to any items in this order.`,
      };
    }
  }

  return { ok: true, promo };
}

/** What applying a `free_item` code puts into the cart. Both halves, always. */
export interface FreeItemInjection {
  /** Append to the cart's lines. */
  line: TicketCartLine;
  /**
   * Use INSTEAD OF the stored promo when totalling: its `value` has been
   * resolved to the item's shelf price. The stored one still says 0.
   */
  promo: PromoDiscount;
}

/**
 * Apply a `free_item` code: the synthetic cart line at the item's shelf price
 * AND the promo with its `value` resolved to that same price. Port of prototype
 * `pages/Till.tsx:574-589`.
 *
 * BOTH HALVES OR NEITHER, and that is why this returns a pair rather than a
 * line. The prototype does two things in the same breath — it builds the line
 * (`pages/Till.tsx:580-587`) and, one line earlier, rewrites the code's value:
 * `const resolvedPromo = { ...promo, value: item.priceTHB }`
 * (`pages/Till.tsx:576`) — and only the resolved copy reaches `computeTotals`.
 * A catalogue stores a free-item code with `value: 0`, because the value is
 * whatever the item costs today, so porting only the line gives a cart whose
 * subtotal has risen by the item's price and whose discount is ฿0: the guest is
 * charged for a free ice cream, the receipt does not reconcile, and the
 * end-of-day markdown the prototype's own comment calls the point of the
 * feature (`pages/Till.tsx:569-573`) records nothing. S2-09a's acceptance
 * criterion is explicit that the code "adds the synthetic line and offsetting
 * discount".
 *
 * `stub` is NOT all borrowed from the first real line, and saying it was
 * "exactly as the prototype does" was wrong. The prototype takes only the
 * package from there — `lines.find(l => !l.promoItem)!.ticketType`
 * (`pages/Till.tsx:577`) — and takes the tier from the till's own current
 * state (`tier: tier!`, `pages/Till.tsx:583`), which is the tier the staff
 * member has selected, not necessarily the first line's. `freeItemStub` below
 * reads both off the first real line, which is the same value in every cart
 * the till can build (a tier change re-prices every line) and is behaviourally
 * inert because the line carries no participants and so is never priced. A
 * caller with a tier of its own should pass it rather than take the default.
 */
export function applyFreeItemPromo(
  promo: PromoDiscount,
  item: { name: string; price: Satang },
  stub: { packageId: string; package: TicketCartLine['package']; tier: string },
): FreeItemInjection {
  return {
    line: {
      id: freeItemLineId(promo.code),
      packageId: stub.packageId,
      package: stub.package,
      tier: stub.tier,
      kids: 0,
      adults: 0,
      socks: 0,
      addOns: [],
      lineTotal: item.price,
      promoItem: {
        itemId: promo.freeItemId ?? '',
        itemKind: promo.freeItemKind ?? 'menu',
        name: item.name,
        price: item.price,
      },
    },
    promo: { ...promo, value: item.price },
  };
}

/**
 * The stub a free-item line borrows, taken from the first line that is not
 * itself a promo line. `null` when the cart holds no real line — the prototype
 * asserts one exists with a `!` and would crash; `validatePromoCode` refuses a
 * free-item code on an empty cart before it gets that far, and returning null
 * lets a caller refuse rather than throw if it ever does.
 */
export function freeItemStub(
  lines: readonly TicketCartLine[],
): { packageId: string; package: TicketCartLine['package']; tier: string } | null {
  const real = lines.find((line) => !line.promoItem);
  if (!real) return null;
  return { packageId: real.packageId, package: real.package, tier: real.tier };
}

/** The id a free-item line carries, so removing the code removes the line. */
export function freeItemLineId(code: string): string {
  return `promo-${code}`;
}
