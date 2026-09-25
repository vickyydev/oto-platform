import type {
  Discount,
  FnbOrderLine,
  ManualDiscount,
  MenuCategoryDef,
  MerchOrderLine,
  TaxConfig,
} from '@/types';
import { effectiveTaxCategory } from '@/lib/menu';
import { getMenuCategories } from '@/store/catalogStore';
import {
  engineManualDiscount,
  enginePromo,
  engineTaxConfig,
  isOffLedgerFnbLine,
  pricingContext,
  toBaht,
  toSatang,
} from '@/lib/cartWire';
import { branchTradingDate, todayRateMode, type RateMode } from '@/lib/pricingMode';
import {
  computeTicketCartTotals,
  validatePromoCode as validateEnginePromoCode,
  type PromoValidation,
  type TaxableCategory,
  type TicketCartLine,
} from '@oto/shared';

/**
 * A PROMO CODE AT THE F&B AND SHOP COUNTERS — SCRUM-362.
 *
 * The ticket till has had a code entry since the prototype; the two item
 * stations never did, so `promos` on their cart payload was always empty even
 * after SCRUM-344 taught the engine's scope matcher what a food or shop row is.
 * This module is the half of that entry which decides money, kept away from
 * React so both stations and both local totals helpers can call it.
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
 * WHAT IT DOES NOT DO: re-total the order. The prototype's `computeFnbTotals`
 * and `computeMerchTotals` still own the subtotal, the manual discounts and the
 * tax cascade on this device. This supplies the promo amount that goes into
 * that cascade, and the per-code rows the panel draws.
 */

/**
 * The package id every item line carries into the engine, and it is the
 * platform's own (`ITEM_LINE_PACKAGE_KEY`, apps/api/src/services/sale.ts). An
 * item line has no ticket package; the field is only read by the `ticketType`
 * scope, which no item row should ever match.
 */
const ITEM_LINE_PACKAGE_KEY = 'item-line';

/** The tier frozen onto an item row. No item price is resolved from a tier. */
const ITEM_LINE_TIER = 'item';

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

/** An F&B line, told from a shop line by the field that carries its item. */
function isFnbLine(line: FnbOrderLine | MerchOrderLine): line is FnbOrderLine {
  return 'menuItem' in line;
}

/**
 * The item's own menu category and its parent, in that order — the walk an
 * `fnbCategory` scope matches on, built the way the platform builds it
 * (`categoryWalk` in apps/api/src/services/sale.ts) and answering the same
 * question the prototype's `menuItemMatchesTarget` answers: a code scoped to a
 * top-level category covers its sub-categories.
 */
function categoryWalk(categoryId: string | undefined, categories: MenuCategoryDef[]): string[] {
  if (!categoryId) return [];
  const own = categories.find((c) => c.id === categoryId);
  const parentId = own?.parentId;
  return parentId ? [categoryId, parentId] : [categoryId];
}

/**
 * One F&B or shop row in the engine's terms: one priced quantity of one
 * catalogue item on a line of its own, carrying what it IS so a scoped code can
 * find it. The same shape `resolveItemLines` builds on the platform, which is
 * what makes the two answers comparable.
 *
 * The unit price is derived from the row's own line total rather than re-read
 * from the catalogue, so `lineTotal` and the priced line always agree and the
 * engine's stale-line guard has nothing to refuse: the figure on the screen is
 * the figure the code is applied to.
 */
function engineItemLine(
  line: FnbOrderLine | MerchOrderLine,
  categories: MenuCategoryDef[],
): TicketCartLine {
  const fnb = isFnbLine(line);
  const item = fnb ? line.menuItem : line.merchItem;
  const taxCategory: TaxableCategory = fnb
    ? effectiveTaxCategory(line.menuItem, categories)
    : (line.merchItem.taxCategoryOverride ?? 'merch');
  const quantity = Math.max(0, line.qty);
  const unit = quantity > 0 ? Math.round(toSatang(line.lineTotal) / quantity) : 0;
  return {
    id: line.id,
    packageId: ITEM_LINE_PACKAGE_KEY,
    package: { prices: {}, adultRules: null },
    tier: ITEM_LINE_TIER,
    kids: 0,
    adults: 0,
    socks: 0,
    addOns: [
      {
        id: item.id,
        name: item.name,
        price: unit,
        quantity,
        taxCategoryOverride: taxCategory,
        itemKind: fnb ? ('menu' as const) : ('merch' as const),
        categoryIds: fnb ? categoryWalk(line.menuItem.category, categories) : [],
      },
    ],
    lineTotal: unit * quantity,
  };
}

/**
 * The rows a code can reach: every line except one that was not bought here.
 *
 * A prepaid F&B line is kept off the payload (`isOffLedgerFnbLine`) because the
 * ledger has no entitlement to take it off, so it is kept out of the local
 * scope too — otherwise a food-scoped code would find a base on this device
 * that the platform never sees.
 */
export function engineItemLines(
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  categories: MenuCategoryDef[] = getMenuCategories(),
): TicketCartLine[] {
  return lines
    .filter((line) => !isFnbLine(line) || !isOffLedgerFnbLine(line))
    .map((line) => engineItemLine(line, categories));
}

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
  const engineLines = engineItemLines(lines, categories);
  if (engineLines.length === 0) return EMPTY_RESULT;
  const totals = computeTicketCartTotals(
    engineLines,
    promos.map(enginePromo),
    manualDiscounts.map(engineManualDiscount),
    engineTaxConfig(options.config),
    pricingContext(options.mode ?? todayRateMode().mode),
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
 * A FREE-ITEM CODE IS REFUSED HERE, and that is this station's own rule rather
 * than the engine's. The engine resolves a free-item code against the cart line
 * the till mints for it, keyed `promo-<CODE>` (`freeItemLineId`), and an item
 * line reaches the platform under a uuid derived from its id (`platformId`,
 * lib/cartWire.ts) because `POST /sales` takes nothing else. So the platform
 * would find no such line, take nothing off, and refuse the commit against a
 * screen that had shown the item free. Refusing at the entry is the honest half
 * of that: no station shows a discount the ledger will not agree to.
 */
export function validateItemPromoCode(
  promo: Discount,
  lines: readonly (FnbOrderLine | MerchOrderLine)[],
  options: ValidateItemPromoOptions = {},
): PromoValidation {
  if (promo.type === 'free_item') {
    return {
      ok: false,
      reason: `Code "${promo.code}" gives a free item, which only the ticket till can put on a bill.`,
    };
  }
  const categories = options.categories ?? getMenuCategories();
  const engineLines = engineItemLines(lines, categories);
  return validateEnginePromoCode(
    enginePromo(promo),
    engineLines,
    options.today ?? branchTradingDate(),
    pricingContext(options.mode ?? todayRateMode().mode),
    {
      ...(options.applied ? { appliedPromos: options.applied.map(enginePromo) } : {}),
      ...(options.customerPhone ? { customerPhone: options.customerPhone } : {}),
    },
  );
}
