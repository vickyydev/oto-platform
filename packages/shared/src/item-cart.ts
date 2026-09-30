import type { Satang, WWPrice } from './money';
import type { RateMode } from './pricing-mode';
import { resolveRate } from './pricing-mode';
import type { TaxableCategory } from './catalog-shapes';
import type { PricingContext, TicketCartLine } from './pricing';
import { priceCartLine } from './pricing';

/**
 * THE ITEM ENGINE — an F&B or shop line, priced in satang. SCRUM-271, plan
 * `docs/progress/plans/offline/PLAN.md` §2.7 and Round 2 ("one calculator").
 *
 * WHY IT IS HERE. Until this file the only code that priced an F&B or shop item
 * in satang was the platform's `resolveItemLines` (`apps/api/src/services/
 * sale.ts`), inside a function that also reads the database, and the till
 * priced the same item a second time in baht floats from the prototype's
 * `computeUnitPrice` (`lib/fnb.ts`) and `computeMerchLineTotal` (`lib/merch.ts`).
 * A box selling offline (plan §2.4) has neither a database nor a reason to
 * trust a till's floats, so the rules move here, beside `computeTicketCartTotals`,
 * and the platform, the till and the box price an item with the same code.
 *
 * WHAT IT IS, EXACTLY. The pure half of `resolveItemLines`, moved and not
 * rewritten: the unit price composed from the item and its chosen options at
 * the rate mode, the category walk an `fnbCategory` scope matches on, the
 * taxable area's fallback, and the cart line an item becomes so that ONE
 * cascade — `computeTicketCartTotals` — totals tickets, food and merchandise
 * together. What stays with the caller is everything that needs a catalogue it
 * cannot be handed as arguments: which options the item offers, whether the
 * chosen ones are allowed, which size came off the shelf, where the prep ticket
 * prints.
 *
 * THE THREE RULES, all of them the prototype's (restated from
 * `resolveItemLines`, where they were first written down):
 *   1. THE UNIT PRICE IS THE ITEM'S PRICE PLUS THE CHOSEN OPTIONS' DELTAS, each
 *      resolved at this rate mode — `computeUnitPrice` (`lib/fnb.ts:28-42`).
 *   2. A TIER DOES NOT DISCOUNT FOOD OR MERCHANDISE. Nothing here takes a tier
 *      that could pick a price; the tier on the line is a frozen label.
 *   3. MERCHANDISE HAS NO MODIFIERS — a shop line is an item with no options,
 *      which `itemUnitPrice(price, [], mode)` is (`lib/merch.ts:19`).
 *
 * Pure, in the sense `engine.ts` defines: no clock, no store, no locale, no
 * floats — every amount in and out is integer satang.
 */

/**
 * The `packageId` an item line's cart line carries.
 *
 * It is NOT a package and names no row: an item line has no admission on it, so
 * there is nothing for a `ticketType`-scoped discount to match, and a real
 * package id here would make one match something it never sold. The platform's
 * ledger looks it up among the loaded packages, finds nothing, and writes
 * `ticket_package_id` null.
 */
export const ITEM_LINE_PACKAGE_KEY = 'item-line';

/** What an item line is: something from the menu, or something from the shop. */
export type ItemKind = 'menu' | 'merch';

/**
 * A weekday/weekend pair as the catalogue's two columns hold it. A weekend
 * price is optional there, and an item without one costs its weekday price at
 * the weekend too.
 */
export function itemPricePair(weekday: Satang, weekend: Satang | null | undefined): WWPrice {
  return { weekday, weekend: weekend ?? weekday };
}

/** One item's price at a rate mode, with the parts it was composed from. */
export interface ItemUnitPrice {
  /** The item's own price. */
  base: Satang;
  /** Each chosen option's delta, in the order the options were given. */
  options: Satang[];
  /** `base` plus every delta: what ONE of this item costs. */
  unit: Satang;
}

/**
 * RULE 1: the item's price plus every chosen option's delta, each resolved at
 * `mode`. The caller passes the options in the order it wants them itemised
 * (the platform: group order, then the order they were chosen in), and gets the
 * deltas back in that order.
 */
export function itemUnitPrice(
  price: WWPrice,
  options: readonly WWPrice[],
  mode: RateMode,
): ItemUnitPrice {
  const base = resolveRate(price, mode);
  const deltas = options.map((option) => resolveRate(option, mode));
  let unit = base;
  for (const delta of deltas) unit += delta;
  return { base, options: deltas, unit };
}

/** What `quantity` of an item at `unitPrice` comes to. */
export function itemLineTotal(unitPrice: Satang, quantity: number): Satang {
  return unitPrice * quantity;
}

/**
 * The taxable area an item's money lands in: what the catalogue resolved (the
 * item's override, else its category's, else that category's parent's), and
 * where nothing in that chain answers, `fnb` for a menu item and `merch` for a
 * shop item — the prototype's own fallback on each side (`lib/menu.ts:101-110`,
 * `lib/merch.ts:merchTaxInputs`).
 */
export function itemTaxCategory(
  itemKind: ItemKind,
  resolved: TaxableCategory | null | undefined,
): TaxableCategory {
  return resolved ?? (itemKind === 'merch' ? 'merch' : 'fnb');
}

/**
 * The item's own menu category and its parent, in that order — the walk an
 * `fnbCategory` scope matches on. Two levels is the whole tree, so this is
 * never longer than two ids; `parentOf` answers the parent of the category it
 * is given, or nothing for a top-level one.
 */
export function itemCategoryWalk(
  categoryId: string | null | undefined,
  parentOf: (categoryId: string) => string | null | undefined,
): string[] {
  if (!categoryId) return [];
  const parentId = parentOf(categoryId);
  return parentId ? [categoryId, parentId] : [categoryId];
}

/** One F&B or shop line, priced, in the terms `itemCartLine` takes. */
export interface ItemLineInput {
  /** The cart line id — the till's, as it reaches the platform. */
  id: string;
  /** The catalogue item (`pos.product.id`). */
  itemId: string;
  /** The line's label: "Grip Socks — M" when a size was sold. */
  name: string;
  itemKind: ItemKind;
  /** What one costs — `itemUnitPrice(...).unit`. */
  unitPrice: Satang;
  quantity: number;
  /** The taxable area, already resolved — `itemTaxCategory`. */
  taxCategory: TaxableCategory;
  /** The item's category walk — `itemCategoryWalk`. Empty for a shop item. */
  categoryIds?: readonly string[];
  /** The tier frozen on the row (rule 2: it prices nothing). */
  tier: string;
}

/**
 * THE CART LINE AN ITEM BECOMES, so the whole bill goes through one cascade.
 *
 * One priced quantity of one catalogue item with its own taxable area is
 * exactly what a `CartAddOn` is, on a line with no participants. That is not a
 * trick to get around the engine: it means the item's money is decomposed into
 * units, bounded by the discount ledger, run through the same tax cascade and
 * apportioned back the same way admission is, instead of a second set of totals
 * arithmetic living beside it.
 *
 * `itemKind` and `categoryIds` are what tell the row apart from a ticket
 * add-on, so a code scoped to food reaches it and a code scoped to add-ons does
 * not (SCRUM-344, `CartAddOn.itemKind`).
 *
 * The line total is `priceCartLine`'s, which for a line with no participants is
 * the unit price times the quantity.
 */
export function itemCartLine(input: ItemLineInput, ctx: PricingContext): TicketCartLine {
  const line: TicketCartLine = {
    id: input.id,
    packageId: ITEM_LINE_PACKAGE_KEY,
    package: { prices: {}, adultRules: null },
    tier: input.tier,
    kids: 0,
    adults: 0,
    socks: 0,
    addOns: [
      {
        id: input.itemId,
        name: input.name,
        price: input.unitPrice,
        quantity: input.quantity,
        taxCategoryOverride: input.taxCategory,
        itemKind: input.itemKind,
        categoryIds: input.categoryIds ?? [],
      },
    ],
    lineTotal: 0,
  };
  line.lineTotal = priceCartLine(line, ctx);
  return line;
}
