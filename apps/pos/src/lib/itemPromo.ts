import type {
  Discount,
  FnbOrder,
  FnbOrderLine,
  ManualDiscount,
  MenuCategoryDef,
  MerchOrder,
  MerchOrderLine,
  TaxConfig,
} from '@/types';
import { getMenuCategories, getMenuItems, getMerchItems } from '@/store/catalogStore';
import {
  engineItemLines,
  engineItemPromos,
  engineManualDiscount,
  enginePromo,
  freeItemLineOf,
  engineTaxConfig,
  pricingContext,
  toBaht,
} from '@/lib/cartWire';
import { branchTradingDate, todayRateMode, type RateMode } from '@/lib/pricingMode';
import {
  computeTicketCartTotals,
  validatePromoCode as validateEnginePromoCode,
  type PromoValidation,
} from '@oto/shared';

/**
 * A PROMO CODE AT THE F&B AND SHOP COUNTERS — SCRUM-362.
 *
 * The ticket till has had a code entry since the prototype; the two item
 * stations never did, so `promos` on their cart payload was always empty even
 * after SCRUM-344 taught the engine's scope matcher what a food or shop row is.
 * This module is the half of that entry which decides money, kept away from
 * React so both stations can call it.
 *
 * ONE ARITHMETIC, FOR THE SAME REASON THE REST OF S2-09b HAS ONE. An order with
 * a code on it is quoted by the platform, and the platform prices the code with
 * `computeTicketCartTotals` over rows carrying `itemKind` and the item's
 * category walk (`resolveItemLines`, apps/api/src/services/sale.ts). If this
 * till applied the same code with its own arithmetic the two figures would part
 * company on exactly the orders a code is used on, and the commit — which sends
 * the figure the screen showed as `expectedTotalSatang` — would be refused. So
 * the item lines are mapped into the engine's terms the way the platform maps
 * them, and the engine is asked; nothing here computes a discount itself.
 *
 * SCRUM-271 — THE ROWS ARE THE SHARED ITEM ENGINE'S. They used to be built here
 * by a copy of the platform's construction; they are built now by the function
 * the platform builds them with (`itemCartLine` in `@oto/shared`), through
 * `engineItemLines` in `lib/cartWire.ts`, which is also what totals the order
 * on this device (`itemOrderTotals`) now that the prototype's `computeFnbTotals`
 * and `computeMerchTotals` are gone.
 */

/** The rows a code can reach — see `engineItemLines` in `lib/cartWire.ts`. */
export { engineItemLines };

/** One applied code as the panel and the customer display draw it, in baht. */
export interface ItemAppliedPromo {
  code: string;
  label: string;
  type: Discount['type'];
  amount: number;
  /** Set when the code found nothing left in its own scope — the engine's words. */
  exhaustedReason?: string;
}

export interface ItemPromoResult {
  /** ฿ the codes took off, for the tax cascade and the panel. */
  discountAmount: number;
  appliedPromos: ItemAppliedPromo[];
}

const EMPTY_RESULT: ItemPromoResult = { discountAmount: 0, appliedPromos: [] };

export interface ItemPromoOptions {
  mode?: RateMode;
  config?: TaxConfig;
  categories?: MenuCategoryDef[];
}

/**
 * What the codes on an F&B or shop order take off it, through the engine.
 *
 * The manual discounts are passed in because the engine runs them FIRST and a
 * code only reaches what they left (`computeTicketCartTotals`); leaving them out
 * would let a code spend money a staff discount has already spent.
 */
export function computeItemPromoDiscount(
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  manualDiscounts: readonly ManualDiscount[],
  promos: readonly Discount[],
  options: ItemPromoOptions = {},
): ItemPromoResult {
  if (promos.length === 0) return EMPTY_RESULT;
  const categories = options.categories ?? getMenuCategories();
  const ctx = pricingContext(options.mode ?? todayRateMode().mode);
  const engineLines = engineItemLines(lines, categories, ctx);
  if (engineLines.length === 0) return EMPTY_RESULT;
  const totals = computeTicketCartTotals(
    engineLines,
    engineItemPromos(promos, lines),
    manualDiscounts.map(engineManualDiscount),
    engineTaxConfig(options.config),
    ctx,
  );
  return {
    discountAmount: toBaht(totals.promoDiscountTotal),
    appliedPromos: totals.appliedPromos.map((promo) => ({
      code: promo.code,
      label: promo.label,
      type: promo.type,
      amount: toBaht(promo.amount),
      ...(promo.exhaustedReason ? { exhaustedReason: promo.exhaustedReason } : {}),
    })),
  };
}

/**
 * THE CODE ROWS OF A RECORDED F&B OR SHOP ORDER — SCRUM-373.
 *
 * What each code on a closed order took off, for the confirmation's receipt
 * card: the same engine pass over the same lines, staff discounts and codes the
 * order was charged at, so the rows add up to the total above them. A code that
 * took nothing is left off, as the promotions report leaves it off.
 */
export function recordedOrderPromoRows(order: FnbOrder | MerchOrder): ItemAppliedPromo[] {
  if (!order.discounts || order.discounts.length === 0) return [];
  return computeItemPromoDiscount(order.lines, order.manualDiscounts, order.discounts)
    .appliedPromos.filter((promo) => promo.amount > 0);
}

export interface ValidateItemPromoOptions extends ItemPromoOptions {
  /** Codes already on this order — the stacking and duplicate rules read them. */
  applied?: readonly Discount[];
  /** Known only where a band or a party tab named the customer. */
  customerPhone?: string;
  /** The branch's business date; taken from the trading calendar when absent. */
  today?: string;
}

/**
 * Whether a code can go on this F&B or shop order, and why not when it cannot.
 *
 * The rules are the engine's `validatePromoCode` — the same active flag, date
 * window, usage limits, stacking rules and scope check the ticket till applies
 * — run over this station's copy of the park's discount definitions, so the
 * refusal wording is the one reception already reads at the till. It is a
 * first reading, not the verdict: since SCRUM-401 the platform prices every
 * code itself, from the definitions as they stand when it quotes and commits
 * the order, and it may refuse a code this copy accepted — one archived or
 * switched off since the copy was taken, a usage limit reached at another
 * station, a code the platform never had. The station then drops that code
 * and shows the platform's reason (`pages/OrderStation.tsx`,
 * `pages/MerchStation.tsx`); a code refused here simply never goes out.
 *
 * A FREE-ITEM CODE TAKES ONE OF ITS ITEM OFF A LINE ALREADY ON THE ORDER
 * (SCRUM-368). The platform aims such a code at the first line holding the
 * code's product and takes one unit off it (`promo-codes.ts`, `judge`), and this
 * station prices it the same way (`engineItemPromos`). The code adds nothing:
 * where no line holds the item — a free ice cream typed on the shop screen, or
 * on an F&B order with no ice cream on it — it is refused with the platform's
 * own words, rather than accepted for a figure the ledger would not agree to.
 */
export function validateItemPromoCode(
  promo: Discount,
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  options: ValidateItemPromoOptions = {},
): PromoValidation {
  const categories = options.categories ?? getMenuCategories();
  const ctx = pricingContext(options.mode ?? todayRateMode().mode);
  const engineLines = engineItemLines(lines, categories, ctx);
  let freeItem: { name: string; price: number } | null | undefined;
  if (promo.type === 'free_item') {
    // Lines other free-item codes on the order already took their item off.
    const taken = new Set<string>();
    for (const applied of options.applied ?? []) {
      const line = freeItemLineOf(applied, lines, taken);
      if (line) taken.add(line.id);
    }
    const line = freeItemLineOf(promo, lines, taken);
    if (!line) {
      const name = freeItemName(promo) ?? 'free item';
      return { ok: false, reason: `Code "${promo.code}" gives a free ${name}, and there is no ${name} on this order.` };
    }
    const item = 'menuItem' in line ? line.menuItem : line.merchItem;
    freeItem = { name: item.name, price: Math.round((line.lineTotal * 100) / Math.max(1, line.qty)) };
  }
  return validateEnginePromoCode(
    enginePromo(promo),
    engineLines,
    options.today ?? branchTradingDate(),
    ctx,
    {
      ...(options.applied ? { appliedPromos: options.applied.map(enginePromo) } : {}),
      ...(options.customerPhone ? { customerPhone: options.customerPhone } : {}),
      ...(freeItem !== undefined ? { freeItem } : {}),
    },
  );
}

/** The name of a free-item code's item from this station's catalogue copy, or null. */
function freeItemName(promo: Discount): string | null {
  if (!promo.freeItemId) return null;
  const pool =
    promo.freeItemKind === 'merch'
      ? getMerchItems().map((m) => ({ id: m.id, name: m.name }))
      : getMenuItems().map((m) => ({ id: m.id, name: m.name }));
  return pool.find((item) => item.id === promo.freeItemId)?.name ?? null;
}
