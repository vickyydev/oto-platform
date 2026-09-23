import { describe, expect, it } from 'vitest';
import { computeLineBreakdown, discountTargetBase, rowMatchesTarget } from '../src/index';
import type { DiscountTarget, PricingContext, TicketCartLine } from '../src/index';

/**
 * SCRUM-344 — which promo scopes reach an F&B or shop line, now that a cart can
 * hold one beside admission.
 *
 * WHY THESE ASSERTIONS AND NOT A TOTALS RUN: `discountTargetBase` is the one
 * function a promo's reach is decided by — `computeTicketCartTotals` asks it for
 * the money a code may come off, and `promoNotApplicableReason` asks it whether
 * there is any. A base of zero IS the bug this ticket fixes (the code applies
 * and takes nothing off), so the base in satang is the thing to assert, and a
 * discounted grand total would only measure it through two more layers.
 *
 * THE FIXTURE is the seeded menu's own filing, because that is what makes the
 * category case worth running: the Iced Latte is under Coffee, a SUB-category of
 * Drinks, so a code scoped to Drinks reaches it only through the parent walk the
 * row carries. Ids are the fixture's own strings rather than uuids — nothing
 * here parses them.
 */

const ctx: PricingContext = {
  mode: 'weekday',
  socks: { addOnId: 'a-socks', price: 12_000, label: 'Regular Socks' },
};

const LATTE = 'p-latte';
const SOCKS_ITEM = 'p-grip-socks';
const COFFEE = 'c-coffee';
const DRINKS = 'c-drinks';
const APPAREL = 'c-apparel';

/**
 * A ticket line: two kids, one adult, a pair of socks and a locker.
 *
 * The add-on and the socks are what the `addOns` scope is supposed to reach,
 * and the control for the half of this ticket that says it must reach NOTHING
 * else.
 */
const ticketLine: TicketCartLine = {
  id: 'line-tickets',
  packageId: 'pkg-play',
  package: { prices: {}, adultRules: null } as TicketCartLine['package'],
  tier: 'tourist',
  kids: 2,
  adults: 1,
  socks: 1,
  addOns: [{ id: 'a-locker', name: 'Locker', price: 5_000, quantity: 1 }],
  lineTotal: 0,
};

/**
 * An F&B line and a shop line exactly as `resolveItemLines` builds them
 * (`apps/api/src/services/sale.ts`): one catalogue item as the sole add-on of a
 * participant-less line under the `item-line` package key. If that construction
 * changes, these fixtures are the copy that has to change with it.
 */
const itemLine = (
  id: string,
  addOn: TicketCartLine['addOns'][number],
): TicketCartLine => ({
  id,
  packageId: 'item-line',
  package: { prices: {}, adultRules: null } as TicketCartLine['package'],
  tier: 'tourist',
  kids: 0,
  adults: 0,
  socks: 0,
  addOns: [addOn],
  lineTotal: addOn.price * addOn.quantity,
});

const latteLine = itemLine('line-latte', {
  id: LATTE,
  name: 'Iced Latte',
  price: 9_500,
  quantity: 2,
  taxCategoryOverride: 'fnb',
  itemKind: 'menu',
  categoryIds: [COFFEE, DRINKS],
});

const merchLine = itemLine('line-merch', {
  id: SOCKS_ITEM,
  name: 'Grip Socks',
  price: 12_000,
  quantity: 1,
  taxCategoryOverride: 'merch',
  itemKind: 'merch',
  categoryIds: [APPAREL],
});

const LATTE_BASE = 2 * 9_500;
const MERCH_BASE = 12_000;
/** The locker plus the pair of socks — everything a ticket add-on scope owns. */
const TICKET_ADDON_BASE = 5_000 + 12_000;

const cart = [ticketLine, latteLine, merchLine];
const baseFor = (target: DiscountTarget): number => discountTargetBase(cart, target, ctx);

describe('an item scope reaches the item lines and nothing else', () => {
  it('scopes fnb to the menu line, leaving the shop line and the ticket add-ons alone', () => {
    // Before this ticket this answered 0, so a food code took nothing off.
    expect(baseFor({ kind: 'fnb' })).toBe(LATTE_BASE);
  });

  it('scopes merch to the shop line only', () => {
    expect(baseFor({ kind: 'merch' })).toBe(MERCH_BASE);
  });

  it('names a menu item by the id the row is keyed on', () => {
    expect(baseFor({ kind: 'menuItems', menuItemIds: [LATTE] })).toBe(LATTE_BASE);
    // A merch id in a menu scope is not a menu item, however real the id.
    expect(baseFor({ kind: 'menuItems', menuItemIds: [SOCKS_ITEM] })).toBe(0);
    expect(baseFor({ kind: 'menuItems', menuItemIds: ['p-nothing'] })).toBe(0);
  });
});

describe('a category scope walks the item’s own category and its parent', () => {
  it('matches the item’s own category', () => {
    expect(baseFor({ kind: 'fnbCategory', category: COFFEE })).toBe(LATTE_BASE);
  });

  it('matches the parent, so a code on Drinks reaches a latte filed under Coffee', () => {
    // The case the walk exists for: scoping to a top-level category has to
    // cover its sub-categories, as the prototype's menuItemMatchesTarget does.
    expect(baseFor({ kind: 'fnbCategory', category: DRINKS })).toBe(LATTE_BASE);
  });

  it('does not reach a shop line through its category', () => {
    // Apparel is the socks' own category, and a merch row still answers only to
    // `merch` — the same split cart-totals.ts applies to a free-item promo.
    expect(baseFor({ kind: 'fnbCategory', category: APPAREL })).toBe(0);
  });

  it('finds nothing for a category no line is filed under', () => {
    expect(baseFor({ kind: 'fnbCategory', category: 'c-desserts' })).toBe(0);
  });

  it('matches no category scope when the item is filed under none', () => {
    const uncategorised = [
      itemLine('line-loose', {
        id: 'p-loose',
        name: 'Bottled Water',
        price: 3_000,
        quantity: 1,
        itemKind: 'menu',
        categoryIds: [],
      }),
    ];
    expect(discountTargetBase(uncategorised, { kind: 'fnbCategory', category: DRINKS }, ctx)).toBe(0);
    // It is still food, so the un-scoped food code reaches it.
    expect(discountTargetBase(uncategorised, { kind: 'fnb' }, ctx)).toBe(3_000);
  });
});

describe('the add-on scopes stay with the ticket add-ons', () => {
  it('leaves the food and the merchandise out of addOns', () => {
    // Before this ticket the latte and the socks item answered `true` here,
    // because an item row borrows the `addon` kind: a code for ticket add-ons
    // discounted lunch.
    expect(baseFor({ kind: 'addOns' })).toBe(TICKET_ADDON_BASE);
  });

  it('will not match an item by id in an addOn scope', () => {
    expect(baseFor({ kind: 'addOn', addOnId: LATTE })).toBe(0);
    expect(baseFor({ kind: 'addOn', addOnId: SOCKS_ITEM })).toBe(0);
    // The real add-on and the socks row still answer, unchanged.
    expect(baseFor({ kind: 'addOn', addOnId: 'a-locker' })).toBe(5_000);
    expect(baseFor({ kind: 'addOn', addOnId: 'a-socks' })).toBe(12_000);
  });

  it('still matches no event pass anywhere — no register sells one', () => {
    expect(baseFor({ kind: 'event_pass' })).toBe(0);
  });
});

describe('a ticket-only cart answers exactly as it did', () => {
  const ticketsOnly = [ticketLine];
  const only = (target: DiscountTarget): number => discountTargetBase(ticketsOnly, target, ctx);

  it('finds no base for any item scope', () => {
    expect(only({ kind: 'fnb' })).toBe(0);
    expect(only({ kind: 'merch' })).toBe(0);
    expect(only({ kind: 'menuItems', menuItemIds: [LATTE] })).toBe(0);
    expect(only({ kind: 'fnbCategory', category: DRINKS })).toBe(0);
  });

  it('keeps the add-on scopes on the add-ons', () => {
    expect(only({ kind: 'addOns' })).toBe(TICKET_ADDON_BASE);
    expect(only({ kind: 'addOn', addOnId: 'a-locker' })).toBe(5_000);
  });
});

describe('the row matcher itself', () => {
  /** The rows of the two item lines, which is what the scopes are asked about. */
  const rowOf = (line: TicketCartLine) => computeLineBreakdown(line, ctx)[0]!;
  const latteRow = rowOf(latteLine);
  const merchRow = rowOf(merchLine);

  it('carries the item kind and the category walk onto the breakdown row', () => {
    // The scopes read these two fields and nothing else does; if the carry in
    // computeLineBreakdown is dropped, every assertion above turns into a
    // silent zero rather than a failure that names the cause.
    expect(latteRow).toMatchObject({ kind: 'addon', key: LATTE, itemKind: 'menu' });
    expect(latteRow.categoryIds).toEqual([COFFEE, DRINKS]);
    expect(merchRow).toMatchObject({ key: SOCKS_ITEM, itemKind: 'merch' });
  });

  it('leaves a ticket add-on row with neither field', () => {
    const locker = computeLineBreakdown(ticketLine, ctx).find((r) => r.key === 'a-locker')!;
    expect(locker.itemKind).toBeUndefined();
    expect(locker.categoryIds).toBeUndefined();
  });

  it('answers everything for an item row, as it does for every row', () => {
    expect(rowMatchesTarget(latteRow, 'item-line', { kind: 'everything' }, ctx.socks.addOnId)).toBe(
      true,
    );
  });

  it('answers no ticket scope for an item row', () => {
    for (const target of [
      { kind: 'tickets' },
      { kind: 'ticketGroup', group: 'kids' },
      { kind: 'ticketGroup', group: 'adults' },
      // Named with the key an item line actually carries, so this fails for the
      // right reason if an item row ever starts answering as a ticket.
      { kind: 'ticketType', ticketTypeId: 'item-line' },
    ] as DiscountTarget[]) {
      expect(rowMatchesTarget(latteRow, 'item-line', target, ctx.socks.addOnId)).toBe(false);
      expect(rowMatchesTarget(merchRow, 'item-line', target, ctx.socks.addOnId)).toBe(false);
    }
  });
});
