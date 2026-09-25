import { describe, expect, it } from 'vitest';
import { cartQuote } from './support/fixtures';
import type { CartLine, Discount, FnbOrderLine, ManualDiscount } from '@/types';
import { promoChargeSatang, refusedPromoCodes, type CartQuote } from '@/api/sales';
import { computeItemPromoDiscount, engineItemLines, validateItemPromoCode } from '@/lib/itemPromo';
import { computeLineTotal } from '@/lib/pricing';
import { validatePromoCode } from '@/lib/promoVoucher';
import { getMenuItems, getTicketTypes } from '@/store/catalogStore';

/**
 * PROMO CODES AT THE TILLS — the rules that decide whether a code goes on an
 * order, what it takes off at the F&B and shop counters, and which codes come
 * off again when the platform refuses them (SCRUM-362, SCRUM-401).
 *
 *   - `validatePromoCode`       lib/promoVoucher.ts, the ticket till's check;
 *   - `validateItemPromoCode`,  lib/itemPromo.ts, the F&B and shop stations',
 *     `computeItemPromoDiscount` through the platform's engine;
 *   - `refusedPromoCodes`,      api/sales.ts, read off the platform's quote.
 *     `promoChargeSatang`
 *
 * All of it is pure: the only state read is the catalogue store's seed (the
 * ticket packages and menu below), and nothing is mocked. Taking a refused
 * code off the order is the pages' own effect (`pages/Till.tsx`,
 * `pages/OrderStation.tsx`, `pages/MerchStation.tsx`), which needs the page
 * rendered; what is pinned here is the list that effect acts on.
 */

const TODAY = '2026-09-25';
const oneHour = getTicketTypes().find((ticket) => ticket.id === 't-1h')!;
const nuggets = getMenuItems().find((item) => item.id === 'm-nuggets')!; // Light Bites, under Food
const slushie = getMenuItems().find((item) => item.id === 'm-slushie')!; // Drinks

function ticketLine(overrides: Partial<CartLine> = {}): CartLine {
  const priced = { ticketType: oneHour, tier: 'tourist', kids: 1, adults: 0, socks: 0, addOns: [] };
  return { id: 'line-1', ...priced, lineTotal: computeLineTotal(priced), ...overrides };
}

function fnbLine(overrides: Partial<FnbOrderLine> = {}): FnbOrderLine {
  return { id: 'fnb-1', menuItem: nuggets, qty: 1, selectedModifiers: [], lineTotal: 120, ...overrides };
}

function code(overrides: Partial<Discount> & Pick<Discount, 'code'>): Discount {
  return { label: overrides.code, type: 'percent', value: 10, active: true, ...overrides };
}

const staffDiscount: ManualDiscount = {
  id: 'md-1',
  scope: 'order',
  type: 'fixed',
  value: 50,
  reason: 'Service recovery',
  amountTHB: 50,
  appliedBy: 'Reception',
  appliedById: 'account-1',
  appliedAt: '2026-09-25T04:00:00.000Z',
};

describe('validatePromoCode — the ticket till', () => {
  it('refuses a code already on the order, whatever its case', () => {
    const applied = [code({ code: 'SAVE100', type: 'fixed', value: 100, stackable: true })];
    expect(validatePromoCode(code({ code: 'save100', stackable: true }), [ticketLine()], TODAY, undefined, applied)).toEqual({
      ok: false,
      reason: 'Code "save100" is already applied.',
    });
  });

  it('stacks a second code only when every code on the order is stackable', () => {
    const lines = [ticketLine()];
    const exclusive = code({ code: 'SAVE100', type: 'fixed', value: 100 });
    const stackable = code({ code: 'STAFF10', stackable: true });
    const alsoStackable = code({ code: 'MEMBER20', value: 20, stackable: true });

    expect(validatePromoCode(exclusive, lines, TODAY, undefined, [stackable])).toEqual({
      ok: false,
      reason: 'Code "SAVE100" can\'t be combined with other codes.',
    });
    expect(validatePromoCode(stackable, lines, TODAY, undefined, [exclusive])).toEqual({
      ok: false,
      reason: 'Code "SAVE100" can\'t be combined with other codes — remove it first.',
    });
    expect(validatePromoCode(alsoStackable, lines, TODAY, undefined, [stackable])).toEqual({
      ok: true,
      promo: alsoStackable,
    });
  });

  it('refuses a code switched off, outside its window or used up', () => {
    const lines = [ticketLine()];
    expect(validatePromoCode(code({ code: 'OFF', active: false }), lines, TODAY)).toEqual({
      ok: false,
      reason: 'Code "OFF" is not currently active.',
    });
    const early = validatePromoCode(code({ code: 'SOON', validFrom: '2026-10-01' }), lines, TODAY);
    expect(early.ok).toBe(false);
    expect(!early.ok && early.reason).toMatch(/^Code "SOON" is not valid until /);
    const late = validatePromoCode(code({ code: 'GONE', validUntil: '2026-09-24' }), lines, TODAY);
    expect(!late.ok && late.reason).toMatch(/^Code "GONE" expired on /);
    // The window is inclusive at both ends.
    expect(validatePromoCode(code({ code: 'LAST', validFrom: TODAY, validUntil: TODAY }), lines, TODAY).ok).toBe(true);
    expect(validatePromoCode(code({ code: 'USED', usageLimit: 50, usedCount: 50 }), lines, TODAY)).toEqual({
      ok: false,
      reason: 'Code "USED" has reached its total usage limit.',
    });
  });

  it('holds a guest to their own limit, only when the till knows who they are', () => {
    const lines = [ticketLine()];
    const once = code({ code: 'ONCE', perCustomerLimit: 1, perCustomerUsage: { '+66811111111': 1 } });
    const twice = code({ code: 'TWICE', perCustomerLimit: 2, perCustomerUsage: { '+66811111111': 2 } });
    expect(validatePromoCode(once, lines, TODAY, '+66811111111')).toEqual({
      ok: false,
      reason: 'This code can only be used once per customer.',
    });
    expect(validatePromoCode(twice, lines, TODAY, '+66811111111')).toEqual({
      ok: false,
      reason: 'This code can only be used 2 times per customer.',
    });
    expect(validatePromoCode(once, lines, TODAY, '+66822222222').ok).toBe(true);
    expect(validatePromoCode(once, lines, TODAY).ok).toBe(true);
  });

  it('refuses a code that finds nothing on the order to take money off', () => {
    const lines = [ticketLine()];
    for (const target of [
      { kind: 'ticketType', ticketTypeId: 't-fd' } as const,
      { kind: 'fnb' } as const,
      { kind: 'ticketGroup', group: 'adults' } as const,
    ]) {
      expect(validatePromoCode(code({ code: 'SCOPED', target }), lines, TODAY)).toEqual({
        ok: false,
        reason: 'Code "SCOPED" doesn\'t apply to any items in this order.',
      });
    }
    expect(validatePromoCode(code({ code: 'EMPTY' }), [], TODAY).ok).toBe(false);
    expect(validatePromoCode(code({ code: 'KIDS', target: { kind: 'ticketGroup', group: 'kids' } }), lines, TODAY).ok).toBe(true);
  });

  it('gives a free item only on an order with something on it, and only an item still sold', () => {
    const iceCream = code({ code: 'ICECREAM', type: 'free_item', value: 0, freeItemId: 'm-icecream', freeItemKind: 'menu' });
    expect(validatePromoCode(iceCream, [], TODAY)).toEqual({
      ok: false,
      reason: 'Code "ICECREAM" requires at least one item in the cart.',
    });
    expect(validatePromoCode({ ...iceCream, freeItemId: 'm-withdrawn' }, [ticketLine()], TODAY)).toEqual({
      ok: false,
      reason: 'Code "ICECREAM" references an item that is no longer available.',
    });
    expect(validatePromoCode(iceCream, [ticketLine()], TODAY).ok).toBe(true);
  });
});

describe('validateItemPromoCode — the F&B and shop stations', () => {
  const options = { today: TODAY, mode: 'weekday' as const };

  it('refuses a free-item code: only the ticket till can put one on a bill', () => {
    const iceCream = code({ code: 'ICECREAM', type: 'free_item', value: 0, freeItemId: 'm-icecream' });
    expect(validateItemPromoCode(iceCream, [fnbLine()], options)).toEqual({
      ok: false,
      reason: 'Code "ICECREAM" gives a free item, which only the ticket till can put on a bill.',
    });
  });

  it('refuses a code already on the order, whatever its case', () => {
    const applied = [code({ code: 'STAFF10', stackable: true })];
    expect(validateItemPromoCode(code({ code: 'staff10', stackable: true }), [fnbLine()], { ...options, applied })).toEqual({
      ok: false,
      reason: 'Code "staff10" is already applied.',
    });
  });

  it('lets a code scoped to a category reach the items of its sub-categories, and nothing outside it', () => {
    const food = code({ code: 'FOOD10', target: { kind: 'fnbCategory', category: 'food' } });
    expect(validateItemPromoCode(food, [fnbLine()], options).ok).toBe(true);
    expect(validateItemPromoCode(food, [fnbLine({ menuItem: slushie, lineTotal: 90 })], options)).toEqual({
      ok: false,
      reason: 'Code "FOOD10" doesn\'t apply to any items in this order.',
    });
  });

  it('keeps a prepaid line out of reach: it was not bought here', () => {
    const prepaid = fnbLine({ id: 'fnb-prepaid', lineTotal: 0, isPrepaid: true });
    expect(engineItemLines([prepaid, fnbLine({ id: 'fnb-2' })]).map((line) => line.id)).toEqual(['fnb-2']);
    expect(validateItemPromoCode(code({ code: 'FNB10', target: { kind: 'fnb' } }), [prepaid], options).ok).toBe(false);
  });
});

describe('computeItemPromoDiscount — what a code takes off an F&B or shop order', () => {
  const options = { mode: 'weekday' as const };

  it('takes nothing without a code', () => {
    expect(computeItemPromoDiscount([fnbLine()], [], [], options)).toEqual({ discountAmount: 0, appliedPromos: [] });
  });

  it('prices a scoped code over the rows it reaches, in baht', () => {
    const food = code({ code: 'FOOD10', label: 'Food 10%', target: { kind: 'fnbCategory', category: 'food' } });
    const order = [fnbLine(), fnbLine({ id: 'fnb-2', menuItem: slushie, lineTotal: 90 })];
    expect(computeItemPromoDiscount(order, [], [food], options)).toEqual({
      discountAmount: 12,
      appliedPromos: [{ code: 'FOOD10', label: 'Food 10%', type: 'percent', amount: 12 }],
    });
  });

  it('lets a code spend only what the staff discount left', () => {
    const hundredOff = code({ code: 'SAVE100', type: 'fixed', value: 100 });
    expect(computeItemPromoDiscount([fnbLine()], [staffDiscount], [hundredOff], options).discountAmount).toBe(70);
    expect(computeItemPromoDiscount([fnbLine()], [], [hundredOff], options).discountAmount).toBe(100);
  });

  it('never discounts a prepaid line', () => {
    const prepaid = fnbLine({ id: 'fnb-prepaid', lineTotal: 0, isPrepaid: true });
    const fnb = code({ code: 'FNB10', target: { kind: 'fnb' } });
    expect(computeItemPromoDiscount([prepaid], [], [fnb], options)).toEqual({ discountAmount: 0, appliedPromos: [] });
  });
});

/** The platform's quote of a ฿690 ticket with a code on it: ฿621 to pay. */
const quote = (overrides: Partial<CartQuote> = {}): CartQuote =>
  cartQuote(621, { rejectedPromoCodes: [], ...overrides });

describe('refusedPromoCodes — the codes that come off the order (SCRUM-401)', () => {
  const held = [code({ code: 'STAFF10', stackable: true }), code({ code: 'SONGKRAN25', stackable: true })];

  it("names each code the platform refused that this till holds, with the platform's reason", () => {
    const refused = quote({
      rejectedPromoCodes: [
        { code: 'SONGKRAN25', reason: 'This code has been withdrawn' },
        // A voucher's code rides in promoCodes, not as a discount: nothing to take off.
        { code: 'B1RT7KMQ4XW', reason: 'Already redeemed' },
      ],
    });
    expect(refusedPromoCodes(refused, held)).toEqual([{ code: 'SONGKRAN25', reason: 'This code has been withdrawn' }]);
  });

  it('names nothing on a quote this till made itself: only the platform refuses a code', () => {
    const local = quote({ source: 'till', rejectedPromoCodes: [{ code: 'STAFF10', reason: 'stale' }] });
    expect(refusedPromoCodes(local, held)).toEqual([]);
    expect(refusedPromoCodes(quote({ rejectedPromoCodes: undefined }), held)).toEqual([]);
  });
});

describe('promoChargeSatang — the figure a sale with a code reconciles against', () => {
  const staff10 = code({ code: 'STAFF10' });

  it("is the platform's total, in satang, when the platform priced the codes", () => {
    expect(promoChargeSatang(quote(), [staff10])).toBe(62_100);
  });

  it("is left to the till's own figure without a code or without the platform", () => {
    expect(promoChargeSatang(quote(), [])).toBeUndefined();
    expect(promoChargeSatang(quote({ source: 'till' }), [staff10])).toBeUndefined();
  });

  it('never charges for an item the screen still calls free, when the platform refused its code', () => {
    const iceCream = code({ code: 'ICECREAM', type: 'free_item', value: 0, freeItemId: 'm-icecream' });
    const refused = quote({ rejectedPromoCodes: [{ code: 'ICECREAM', reason: 'Used up' }] });
    expect(promoChargeSatang(refused, [iceCream])).toBeUndefined();
    // A refused money-off code is simply not applied: the platform's figure stands.
    const refusedMoneyOff = quote({ rejectedPromoCodes: [{ code: 'STAFF10', reason: 'Withdrawn' }] });
    expect(promoChargeSatang(refusedMoneyOff, [staff10])).toBe(62_100);
  });
});
