import { describe, expect, it } from 'vitest';
import {
  applyStaffBenefits,
  benefitLineRelief,
  benefitLinesOf,
  cartUnits,
  computeTicketCartTotals,
  emptyBenefitUsage,
  isStaffBenefitReason,
  itemCartLine,
  offlineBenefitProfile,
  PRICING_ENGINE_VERSION,
  splitLedgerUnitMoney,
  STAFF_BENEFIT_REASON,
  staffBenefitDiscount,
  staffBenefitNote,
  type BenefitProfile,
  type ManualDiscount,
  type PricingContext,
  type TaxConfigShape,
  type TicketCartLine,
} from '../src/index';

/**
 * S2-21 round 3 — the benefit at checkout, the pure half: the lines a benefit
 * reads, the "Staff benefit" row it lands as, and where that row's money sits
 * (plan §3 "How the relief lands on the bill", §4 "Tax by the wrong category",
 * H14 and H15).
 */

const ctx: PricingContext = {
  mode: 'weekday',
  socks: { addOnId: 'a-socks', price: 4_000, label: 'Socks' },
};

/** Two categories with different VAT, so a wrong attribution moves the tax. */
const splitTax: TaxConfigShape = {
  rates: [
    { id: 'vat7', name: 'VAT', percent: 7 },
    { id: 'zero', name: 'Zero', percent: 0 },
  ],
  categoryRules: [
    { category: 'fnb', taxMode: 'inclusive', taxRateId: 'vat7' },
    { category: 'addons', taxMode: 'inclusive', taxRateId: 'zero' },
    { category: 'merch', taxMode: 'inclusive', taxRateId: 'vat7' },
    { category: 'tickets', taxMode: 'inclusive', taxRateId: 'vat7' },
    { category: 'drop_off', taxMode: 'inclusive', taxRateId: 'vat7' },
    { category: 'stored_value', taxMode: 'none' },
  ],
  discountPlacement: 'before_tax',
};

const COFFEE_CAT = '018f0000-0000-7000-8000-00000000c0f0';
const FOOD_CAT = '018f0000-0000-7000-8000-00000000f00d';

function menuLine(
  id: string,
  itemId: string,
  unitPrice: number,
  quantity: number,
  categoryIds: string[],
  taxCategory: 'fnb' | 'addons' = 'fnb',
): TicketCartLine {
  return itemCartLine(
    {
      id,
      itemId,
      name: itemId,
      itemKind: 'menu',
      unitPrice,
      quantity,
      taxCategory,
      categoryIds,
      tier: 'tourist',
    },
    ctx,
  );
}

const coffeeTwo = () => menuLine('line-coffee', 'm-latte', 9_500, 2, [COFFEE_CAT]);
const sandwich = () => menuLine('line-sandwich', 'm-sandwich', 12_000, 1, [FOOD_CAT], 'addons');

const staffProfile: BenefitProfile = {
  freeItems: [
    {
      id: 'coffee',
      label: 'Free coffee',
      target: { kind: 'fnbCategory', category: COFFEE_CAT },
      quotaPerPeriod: 2,
      period: 'daily',
    },
  ],
};

describe('the lines a benefit reads', () => {
  it('reads the menu lines only, in cart order, with their category walk', () => {
    const shop = itemCartLine(
      {
        id: 'line-socks',
        itemId: 'p-socks',
        name: 'Grip socks',
        itemKind: 'merch',
        unitPrice: 6_000,
        quantity: 1,
        taxCategory: 'merch',
        tier: 'tourist',
      },
      ctx,
    );
    const { lines, cartLineIds } = benefitLinesOf([coffeeTwo(), shop, sandwich()]);
    expect(cartLineIds).toEqual(['line-coffee', 'line-sandwich']);
    expect(lines).toEqual([
      { itemId: 'm-latte', categoryIds: [COFFEE_CAT], qty: 2, lineTotal: 19_000 },
      { itemId: 'm-sandwich', categoryIds: [FOOD_CAT], qty: 1, lineTotal: 12_000 },
    ]);
  });
});

describe('the "Staff benefit" row', () => {
  it('is the prototype’s fold: fixed for the total relief, its reason and note, keyed by the application', () => {
    const cart = [coffeeTwo(), sandwich()];
    const { lines, cartLineIds } = benefitLinesOf(cart);
    const result = applyStaffBenefits(staffProfile, emptyBenefitUsage(), lines);
    const row = staffBenefitDiscount({
      applicationId: '018f0000-0000-7000-8000-0000000000a1',
      result,
      cartLineIds,
      name: 'Nok (Reception)',
      benefitRole: 'staff',
    })!;
    expect(row).toMatchObject({
      id: '018f0000-0000-7000-8000-0000000000a1',
      scope: 'order',
      type: 'fixed',
      value: 19_000,
      reason: STAFF_BENEFIT_REASON,
      note: 'Scanned: Nok (Reception) (staff)',
      lineShares: [{ lineId: 'line-coffee', amount: 19_000 }],
    });
    expect(benefitLineRelief(result, cartLineIds)).toEqual([
      { cartLineId: 'line-coffee', reliefSatang: 19_000 },
    ]);
  });

  it('is a comp for an owner, and nothing at all when the engine relieves nothing', () => {
    const cart = [coffeeTwo()];
    const { lines, cartLineIds } = benefitLinesOf(cart);
    const comp = staffBenefitDiscount({
      applicationId: '018f0000-0000-7000-8000-0000000000a2',
      result: applyStaffBenefits({ comp: true }, emptyBenefitUsage(), lines),
      cartLineIds,
      name: 'Khun Anan (Owner)',
      benefitRole: 'owner',
    })!;
    expect(comp).toMatchObject({ type: 'comp', value: 0, lineShares: [{ lineId: 'line-coffee', amount: 19_000 }] });
    expect(
      staffBenefitDiscount({
        applicationId: '018f0000-0000-7000-8000-0000000000a3',
        result: applyStaffBenefits({}, emptyBenefitUsage(), lines),
        cartLineIds,
        name: 'Nobody',
        benefitRole: 'staff',
      }),
    ).toBeNull();
    expect(staffBenefitNote('Som', null)).toBe('Scanned: Som (staff)');
  });

  it('recognises the reason however a till spelled it', () => {
    for (const r of ['Staff benefit', ' staff  BENEFIT ', 'STAFF BENEFIT']) expect(isStaffBenefitReason(r)).toBe(true);
    for (const r of ['Staff / family', 'Staff benefits', '', null]) expect(isStaffBenefitReason(r)).toBe(false);
  });
});

describe('where the row’s money sits (H14)', () => {
  function priced(manual: ManualDiscount[]) {
    const cart = [coffeeTwo(), sandwich()];
    const totals = computeTicketCartTotals(cart, [], manual, splitTax, ctx);
    const units = cartUnits(cart, ctx);
    return { cart, totals, units, money: splitLedgerUnitMoney(units, totals) };
  }

  function benefitRow(applicationId: string): ManualDiscount {
    const { lines, cartLineIds } = benefitLinesOf([coffeeTwo(), sandwich()]);
    return staffBenefitDiscount({
      applicationId,
      result: applyStaffBenefits(staffProfile, emptyBenefitUsage(), lines),
      cartLineIds,
      name: 'Nok',
      benefitRole: 'staff',
    })!;
  }

  it('a coffee-only benefit on a mixed order comes off the coffee line and the coffee’s VAT, nowhere else', () => {
    const id = '018f0000-0000-7000-8000-0000000000b1';
    const { totals, units, money } = priced([benefitRow(id)]);
    expect(totals.manualAmounts[id]).toBe(19_000);
    expect(totals.total).toBe(12_000);
    // The ledger books it on the coffee unit (index 0) and leaves the sandwich whole.
    expect(totals.manualUnits?.[id]).toEqual([{ index: 0, amount: 19_000 }]);
    expect(units.map((u) => u.lineId)).toEqual(['line-coffee', 'line-sandwich']);
    expect(money[0]!.discount).toBe(19_000);
    expect(money[1]!.discount).toBe(0);
    // The fnb (7 %) basis is gone; the zero-rated sandwich still carries its own ฿120.
    const fnb = totals.taxBreakdown.categories.find((c) => c.category === 'fnb')!;
    const addons = totals.taxBreakdown.categories.find((c) => c.category === 'addons')!;
    expect(fnb.base).toBe(0);
    expect(fnb.tax).toBe(0);
    expect(addons.base).toBe(12_000);
  });

  it('the same amount spread order-wide would have moved the VAT — the reason the row names its lines', () => {
    const id = '018f0000-0000-7000-8000-0000000000b2';
    const { lineShares: _shares, ...orderWide } = benefitRow(id);
    const named = priced([benefitRow(id)]);
    const spread = priced([orderWide]);
    expect(spread.totals.total).toBe(named.totals.total);
    expect(spread.totals.taxTotal).not.toBe(named.totals.taxTotal);
  });

  it('after the order’s own manual discount the cascade caps it, and the cap is what the row records (H15)', () => {
    const id = '018f0000-0000-7000-8000-0000000000b3';
    const manual: ManualDiscount = {
      id: '018f0000-0000-7000-8000-0000000000c1',
      scope: 'order',
      type: 'fixed',
      value: 25_000,
      reason: 'Service recovery',
    };
    const { totals, money } = priced([manual, benefitRow(id)]);
    // ฿310 order, ฿250 off first: the benefit's ฿190 can take only ฿60.
    expect(totals.manualAmounts[manual.id]).toBe(25_000);
    expect(totals.manualAmounts[id]).toBe(6_000);
    expect(totals.total).toBe(0);
    // The ฿250 came off the whole order in proportion, leaving the coffee
    // ฿36.77: that much is booked on the coffee, and the rest of the ฿60 —
    // which the coffee no longer has — is spread over what is left, so the
    // amount is placed whole and nothing is unapplied.
    expect(totals.manualUnits?.[id]).toEqual([{ index: 0, amount: 3_677 }]);
    expect(totals.taxBreakdown.unappliedDiscount).toBe(0);
    expect(money.reduce((sum, m) => sum + m.discount, 0)).toBe(31_000);
  });

  it('a comp is capped at the lines it covered, not anything else on the order', () => {
    const id = '018f0000-0000-7000-8000-0000000000b4';
    const { lines, cartLineIds } = benefitLinesOf([coffeeTwo()]);
    const comp = staffBenefitDiscount({
      applicationId: id,
      result: applyStaffBenefits({ comp: true }, emptyBenefitUsage(), lines),
      cartLineIds,
      name: 'Khun Anan',
      benefitRole: 'owner',
    })!;
    const { totals } = priced([comp]);
    expect(totals.manualAmounts[id]).toBe(19_000);
    expect(totals.total).toBe(12_000);
  });

  it('a discount naming no lines is attributed exactly as before (no manualUnits)', () => {
    const { totals } = priced([
      { id: '018f0000-0000-7000-8000-0000000000c2', scope: 'order', type: 'percent', value: 10, reason: 'Loyalty' },
    ]);
    expect(totals.manualUnits).toBeUndefined();
  });
});

describe('offline, only what carries no quota', () => {
  it('keeps the comp and the standing percent, and drops everything else', () => {
    expect(offlineBenefitProfile({ comp: true, standingDiscount: null })).toEqual({ comp: true });
    expect(
      offlineBenefitProfile({ comp: false, standingDiscount: { percent: 30, target: { kind: 'fnb' } } }),
    ).toEqual({ standingDiscount: { percent: 30, target: { kind: 'fnb' } } });
    expect(offlineBenefitProfile({ comp: false, standingDiscount: null })).toEqual({});
  });

  it('a standing 30 % offline is the engine’s own answer, stamped with its version', () => {
    const { lines } = benefitLinesOf([coffeeTwo()]);
    const result = applyStaffBenefits(
      offlineBenefitProfile({ comp: false, standingDiscount: { percent: 30 } }),
      emptyBenefitUsage(),
      lines,
    );
    expect(result.discountSatang).toBe(5_700);
    expect(result.freeItemsSatang).toBe(0);
    expect(result.engineVersion).toBe(PRICING_ENGINE_VERSION);
  });
});
