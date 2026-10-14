import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cartQuote } from './support/fixtures';
import type { CartLine, Discount, FnbOrder, FnbOrderLine, ManualDiscount, MerchOrder } from '@/types';
import { localItemQuote, promoChargeSatang, refusedPromoCodes, type CartQuote } from '@/api/sales';
import { computeItemPromoDiscount, engineItemLines, recordedOrderPromoRows, validateItemPromoCode } from '@/lib/itemPromo';
import { fnbOrderTaxBreakdown, promoDiscountImpact, salesByCategory, taxReceiptRows, vatSummary } from '@/lib/reporting';
import { getActiveMerchItems, recordFnbOrder, recordMerchOrder } from '@/mockApi';
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

  it('a free-item code takes one of its item off a line holding it, and is refused with no such line (SCRUM-368)', () => {
    const nuggetFree = code({ code: 'FREENUG', type: 'free_item', value: 0, freeItemId: nuggets.id });
    // No nuggets on the order: refused in the platform's words.
    const other = { ...nuggets, id: 'm-other', name: 'Other' };
    expect(validateItemPromoCode(nuggetFree, [fnbLine({ menuItem: other })], options)).toEqual({
      ok: false,
      reason: `Code "FREENUG" gives a free ${nuggets.name}, and there is no ${nuggets.name} on this order.`,
    });
    // Two nuggets at ฿120 each: accepted, and one unit comes off.
    const lines = [fnbLine({ qty: 2, lineTotal: 240 })];
    expect(validateItemPromoCode(nuggetFree, lines, options).ok).toBe(true);
    const priced = computeItemPromoDiscount(lines, [], [nuggetFree], { mode: 'weekday' });
    expect(priced.discountAmount).toBe(120);
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

describe('a code used at the F&B or shop counter, in the till’s own figures (SCRUM-373)', () => {
  // The ticket's own example: a ฿150 F&B order, 10% off with a code, ฿135 paid.
  const day = '2031-01-15';
  const filters = { startDate: day, endDate: day, branchId: 'all' };
  const fnb10 = code({ code: 'FNB10', label: 'F&B 10%', target: { kind: 'fnb' } });
  const lines = [fnbLine({ lineTotal: 150 })];

  function fnbOrder(overrides: Partial<FnbOrder> = {}): FnbOrder {
    return {
      id: 'promo-fnb-1',
      operatorId: 'op-1',
      operatorName: 'Reception',
      lines,
      manualDiscounts: [],
      discounts: [fnb10],
      total: 135,
      pickupCode: '042',
      payment: { creditUsed: 0, cash: 135, card: 0, promptpay: 0 },
      createdAt: `${day}T05:00:00.000Z`,
      status: 'paid',
      refunds: [],
      ...overrides,
    };
  }

  it('taxes the order on what the guest paid, the figure the station was quoted', () => {
    const quoted = localItemQuote('fnb', lines, [], { promos: [fnb10] }).totals;
    expect(quoted.total).toBe(135);
    const breakdown = fnbOrderTaxBreakdown(fnbOrder());
    expect(breakdown.grandTotal).toBe(13_500);
    expect(breakdown.taxTotal).toBe(883); // ฿8.83, not the ฿9.81 of the undiscounted ฿150
    expect(breakdown.taxTotal).toBe(Math.round(quoted.taxTotal * 100));
    // An order with no code is re-totalled as before.
    expect(fnbOrderTaxBreakdown(fnbOrder({ discounts: undefined, total: 150 })).taxTotal).toBe(981);
  });

  it('names the code and its amount on the confirmation card', () => {
    expect(recordedOrderPromoRows(fnbOrder())).toEqual([{ code: 'FNB10', label: 'F&B 10%', type: 'percent', amount: 15 }]);
    expect(recordedOrderPromoRows(fnbOrder({ discounts: undefined }))).toEqual([]);
  });

  it('counts the code in the sales, VAT and promotions reports, at the F&B counter and the shop', () => {
    const merch10 = code({ code: 'SHOP10', label: 'Shop 10%', target: { kind: 'merch' } });
    const merchItem = getActiveMerchItems()[0]!;
    const merch: MerchOrder = {
      id: 'promo-merch-1',
      operatorId: 'op-1',
      operatorName: 'Reception',
      lines: [{ id: 'merch-1', merchItem, qty: 1, lineTotal: 200 }],
      manualDiscounts: [],
      discounts: [merch10],
      total: 180,
      payment: { creditUsed: 0, cash: 180, card: 0, promptpay: 0 },
      createdAt: `${day}T06:00:00.000Z`,
      status: 'paid',
      refunds: [],
    };
    recordFnbOrder(fnbOrder(), { decrementStock: false });
    recordMerchOrder(merch, { decrementStock: false });

    const gross = salesByCategory(filters).reduce((sum, row) => sum + row.grossRevenueSatang, 0);
    expect(gross).toBe(13_500 + 18_000);
    const vat = vatSummary(filters);
    expect(vat.reduce((sum, row) => sum + row.grossSatang, 0)).toBe(13_500 + 18_000);
    expect(taxReceiptRows(filters).map((row) => [row.transactionId, row.grandTotalSatang])).toEqual(
      expect.arrayContaining([['promo-fnb-1', 13_500], ['promo-merch-1', 18_000]]),
    );
    expect(promoDiscountImpact(filters).map((row) => [row.transactionId, row.code, row.amountSatang])).toEqual(
      expect.arrayContaining([['promo-fnb-1', 'FNB10', 1_500], ['promo-merch-1', 'SHOP10', 2_000]]),
    );
  });
});

describe('SCRUM-374 — the platform counts a code’s uses; a till counts only what it took offline', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

  it('both ticket tills count a use locally only on the box lane', () => {
    for (const file of ['pages/Till.tsx', 'components/mobile/MobileTill.tsx']) {
      const page = src(file);
      const at = page.indexOf('incrementPromoUsage(d.code');
      expect(at, file).toBeGreaterThan(-1);
      expect(page.match(/incrementPromoUsage\(d\.code/g), file).toHaveLength(1);
      // The nearest enclosing condition before the call is the lane check.
      const guard = page.lastIndexOf("if (currentLane() === 'box') {", at);
      expect(guard, file).toBeGreaterThan(-1);
      // ...and no block closes between the check and the call.
      expect(page.slice(guard, at)).not.toMatch(/\r?\n {4}\}/);
    }
  });
});
