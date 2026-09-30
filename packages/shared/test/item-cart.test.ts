import { describe, expect, it } from 'vitest';
import {
  computeTicketCartTotals,
  ITEM_LINE_PACKAGE_KEY,
  itemCartLine,
  itemCategoryWalk,
  itemLineTotal,
  itemPricePair,
  itemTaxCategory,
  itemUnitPrice,
} from '../src/index';
import type { PricingContext, TaxConfigShape } from '../src/index';

/**
 * SCRUM-271 — THE ITEM ENGINE (`item-cart.ts`), the pure half of the platform's
 * `resolveItemLines` moved into this package so the till and a box price an
 * F&B or shop line with the platform's code (plan
 * `docs/progress/plans/offline/PLAN.md` §2.7, Round 2).
 *
 * The platform's own suites (`apps/api/test/sales-fnb.test.ts`,
 * `promo-codes.test.ts`, `menu-tax-seam.test.ts`) prove the move changed no
 * figure end to end. These pin the engine's contract on its own, so a box — which
 * has no database behind it — can rely on it without running the api.
 *
 * THE PROTOTYPE FIGURES quoted below are its `computeUnitPrice` and
 * `computeLineTotal` (`lib/fnb.ts:28-54`) and `computeMerchLineTotal`
 * (`lib/merch.ts:19-25`) run on the prototype's seeded menu, in baht, times 100.
 */

const weekday: PricingContext = {
  mode: 'weekday',
  socks: { addOnId: 'a-socks', price: 4_000, label: 'Regular Socks' },
};
const weekend: PricingContext = { ...weekday, mode: 'weekend' };

/** The seeded tax configuration: 7 % VAT included on every category, no service charge. */
const seededTax: TaxConfigShape = {
  rates: [{ id: 'vat7', name: 'VAT', percent: 7 }],
  categoryRules: (['tickets', 'fnb', 'merch', 'addons', 'drop_off', 'stored_value'] as const).map(
    (category) => ({ category, taxMode: 'inclusive' as const, taxRateId: 'vat7' }),
  ),
  discountPlacement: 'before_tax',
};

describe('the unit price — rule 1: the item plus every chosen option, at the rate mode', () => {
  it('adds each option’s delta to the item’s price, and itemises the deltas in the order given', () => {
    // A latte ฿95 weekday / ฿110 weekend, Large +฿20 / +฿25, an extra shot +฿15 flat.
    const latte = itemPricePair(9_500, 11_000);
    const options = [itemPricePair(2_000, 2_500), itemPricePair(1_500, null)];
    expect(itemUnitPrice(latte, options, 'weekday')).toEqual({
      base: 9_500,
      options: [2_000, 1_500],
      unit: 13_000,
    });
    expect(itemUnitPrice(latte, options, 'weekend')).toEqual({
      base: 11_000,
      options: [2_500, 1_500],
      unit: 15_000,
    });
  });

  it('prices an item with no weekend figure at its weekday price all week (the catalogue’s null column)', () => {
    expect(itemPricePair(6_000, null)).toEqual({ weekday: 6_000, weekend: 6_000 });
    expect(itemPricePair(6_000, undefined)).toEqual({ weekday: 6_000, weekend: 6_000 });
    expect(itemUnitPrice(itemPricePair(6_000, null), [], 'weekend').unit).toBe(6_000);
  });

  it('prices a shop item — no modifiers (rule 3) — at its own pair, and the line at unit × quantity', () => {
    // Prototype computeMerchLineTotal: resolveRate(item.price, mode) * qty — Grip Socks ฿60.
    const socks = itemUnitPrice({ weekday: 6_000, weekend: 6_000 }, [], 'weekday');
    expect(socks).toEqual({ base: 6_000, options: [], unit: 6_000 });
    expect(itemLineTotal(socks.unit, 3)).toBe(18_000);
  });
});

describe('the taxable area and the category walk', () => {
  it('keeps what the catalogue resolved, and otherwise falls back to fnb for the menu and merch for the shop', () => {
    expect(itemTaxCategory('menu', 'addons')).toBe('addons');
    expect(itemTaxCategory('menu', null)).toBe('fnb');
    expect(itemTaxCategory('merch', undefined)).toBe('merch');
  });

  it('walks an item’s own category and its parent — two levels is the whole tree', () => {
    const parents: Record<string, string | undefined> = { 'c-coffee': 'c-drinks' };
    const parentOf = (id: string) => parents[id];
    expect(itemCategoryWalk('c-coffee', parentOf)).toEqual(['c-coffee', 'c-drinks']);
    expect(itemCategoryWalk('c-drinks', parentOf)).toEqual(['c-drinks']);
    expect(itemCategoryWalk(null, parentOf)).toEqual([]);
    expect(itemCategoryWalk(undefined, parentOf)).toEqual([]);
  });
});

describe('the cart line an item becomes', () => {
  const latte = itemCartLine(
    {
      id: 'line-latte',
      itemId: 'p-latte',
      name: 'Iced Latte',
      itemKind: 'menu',
      unitPrice: 13_000,
      quantity: 2,
      taxCategory: 'fnb',
      categoryIds: ['c-coffee', 'c-drinks'],
      tier: 'tourist',
    },
    weekday,
  );

  it('is one priced quantity of one item on a line with no participants, under the item-line key', () => {
    expect(latte).toEqual({
      id: 'line-latte',
      packageId: ITEM_LINE_PACKAGE_KEY,
      package: { prices: {}, adultRules: null },
      tier: 'tourist',
      kids: 0,
      adults: 0,
      socks: 0,
      addOns: [
        {
          id: 'p-latte',
          name: 'Iced Latte',
          price: 13_000,
          quantity: 2,
          taxCategoryOverride: 'fnb',
          itemKind: 'menu',
          categoryIds: ['c-coffee', 'c-drinks'],
        },
      ],
      lineTotal: 26_000,
    });
    expect(ITEM_LINE_PACKAGE_KEY).toBe('item-line');
  });

  it('prices the same whatever the rate mode: the unit was resolved before the line was built', () => {
    expect(itemCartLine({ ...latteInput(), unitPrice: 13_000 }, weekend).lineTotal).toBe(26_000);
  });

  it('carries an empty walk for a shop item, so no fnbCategory scope can reach it', () => {
    const tee = itemCartLine(
      { ...latteInput(), id: 'line-tee', itemId: 'p-tee', itemKind: 'merch', taxCategory: 'merch', categoryIds: undefined },
      weekday,
    );
    expect(tee.addOns[0]?.categoryIds).toEqual([]);
    expect(tee.addOns[0]?.itemKind).toBe('merch');
  });

  it('totals through the one cascade: a food-scoped code reaches the latte and not the ticket add-on beside it', () => {
    const ticket = {
      id: 'line-ticket',
      packageId: 'pkg-play',
      package: { prices: { tourist: { weekday: 50_000, weekend: 60_000 } }, adultRules: null },
      tier: 'tourist',
      kids: 1,
      adults: 0,
      socks: 0,
      addOns: [{ id: 'a-locker', name: 'Locker', price: 5_000, quantity: 1 }],
      lineTotal: 55_000,
    };
    const totals = computeTicketCartTotals(
      [ticket, latte],
      [{ code: 'FOOD10', label: 'Food 10%', type: 'percent', value: 10, target: { kind: 'fnb' } }],
      [],
      seededTax,
      weekday,
    );
    expect(totals.subtotal).toBe(81_000);
    // 10 % of the latte's 26000, and nothing of the 55000 of admission and locker.
    expect(totals.promoDiscountTotal).toBe(2_600);
    expect(totals.total).toBe(78_400);
  });
});

function latteInput() {
  return {
    id: 'line-latte',
    itemId: 'p-latte',
    name: 'Iced Latte',
    itemKind: 'menu' as const,
    unitPrice: 13_000,
    quantity: 2,
    taxCategory: 'fnb' as const,
    categoryIds: ['c-coffee', 'c-drinks'],
    tier: 'tourist',
  };
}
