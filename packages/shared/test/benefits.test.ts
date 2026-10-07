import { describe, expect, it } from 'vitest';
import {
  applyStaffBenefits,
  benefitPeriodKey,
  BenefitProfileSchema,
  benefitTargetMatches,
  DEFAULT_ROUNDING,
  emptyBenefitUsage,
  isEmptyBenefitProfile,
  PRICING_ENGINE_VERSION,
  resolveEffectiveBenefitProfile,
  type BenefitLine,
  type BenefitProfile,
  type BenefitUsageState,
} from '../src';

/**
 * S2-21 round 1 — the staff-benefit engine, case by case against the branches
 * of the prototype's `applyStaffBenefits` (lib/benefits.ts:98-190). Every
 * figure is worked by hand from the prototype's rules, in satang. The same
 * carts run through the prototype's own function in
 * `apps/pos/test/benefits-engine-parity.test.ts`.
 */

// A two-level menu, as the prototype's: Coffee sits under Drinks.
const DRINKS = 'cat-drinks';
const COFFEE = 'cat-coffee';
const FOOD = 'cat-food';

const line = (
  itemId: string,
  categoryIds: string[],
  qty: number,
  eachBaht: number,
): BenefitLine => ({
  itemId,
  categoryIds,
  qty,
  lineTotal: qty * eachBaht * 100,
});
const latte = (qty: number) => line('latte', [COFFEE, DRINKS], qty, 65);
const americano = (qty: number) => line('americano', [COFFEE, DRINKS], qty, 60);
const juice = (qty: number) => line('juice', [DRINKS], qty, 55);
const pizza = (qty: number) => line('pizza', [FOOD], qty, 220);

const coffeeQuota = (quotaPerPeriod = 2) => ({
  id: 'coffee',
  label: 'Free coffee',
  target: { kind: 'fnbCategory' as const, category: COFFEE },
  quotaPerPeriod,
  period: 'daily' as const,
});

/** The prototype's seeded templates (catalogStore.ts:802-841), in satang. */
const OWNER: BenefitProfile = { comp: true };
const MANAGER: BenefitProfile = {
  freeItems: [coffeeQuota()],
  credit: { amountSatang: 50_000, period: 'monthly' },
  standingDiscount: { percent: 30, target: { kind: 'fnb' } },
};
const STAFF: BenefitProfile = {
  freeItems: [coffeeQuota()],
  standingDiscount: { percent: 30, target: { kind: 'fnb' } },
};

const used = (coffee = 0, creditSatang = 0): BenefitUsageState => ({
  freeItemsUsed: coffee ? { coffee } : {},
  creditUsedSatang: creditSatang,
});

const amounts = (r: ReturnType<typeof applyStaffBenefits>) => [
  r.compedSatang,
  r.freeItemsSatang,
  r.creditSatang,
  r.discountSatang,
  r.totalReliefSatang,
];

describe('applyStaffBenefits — the prototype’s stages, in satang', () => {
  it('an empty profile relieves nothing', () => {
    const r = applyStaffBenefits({}, emptyBenefitUsage(), [latte(1), pizza(1)]);
    expect(amounts(r)).toEqual([0, 0, 0, 0, 0]);
    expect(r.lineRelief).toEqual([0, 0]);
    expect(r.freeItemUsageDeltas).toEqual([]);
  });

  it('an order worth nothing is relieved of nothing, comp or not', () => {
    expect(amounts(applyStaffBenefits(OWNER, emptyBenefitUsage(), []))).toEqual([0, 0, 0, 0, 0]);
    expect(
      amounts(applyStaffBenefits(OWNER, emptyBenefitUsage(), [line('water', [DRINKS], 1, 0)])),
    ).toEqual([0, 0, 0, 0, 0]);
  });

  it('a comp ends the calculation: the whole order is free, and nothing is used', () => {
    const r = applyStaffBenefits(
      { ...OWNER, freeItems: [coffeeQuota()], credit: { amountSatang: 50_000, period: 'monthly' } },
      emptyBenefitUsage(),
      [latte(2), pizza(1)],
    );
    expect(amounts(r)).toEqual([35_000, 0, 0, 0, 35_000]);
    expect(r.lineRelief).toEqual([13_000, 22_000]);
    expect(r.freeItemUsageDeltas).toEqual([]);
    expect(r.creditUsedDelta).toBe(0);
  });

  it('Staff: two free coffees, then 30 % off what is left', () => {
    // Lattes ฿130 free; pizza ฿220 × 30 % = ฿66.
    const r = applyStaffBenefits(STAFF, emptyBenefitUsage(), [latte(2), pizza(1)]);
    expect(amounts(r)).toEqual([0, 13_000, 0, 6_600, 19_600]);
    expect(r.freeItemUsageDeltas).toEqual([{ benefitId: 'coffee', qtyUsed: 2 }]);
    expect(r.lineRelief).toEqual([13_000, 6_600]);
  });

  it('a coffee already used today leaves one; the second latte takes the percentage', () => {
    // One latte free (฿65); the other ฿65 × 30 % = ฿19.50 → ฿20 (whole baht, half-up).
    const r = applyStaffBenefits(STAFF, used(1), [latte(2), pizza(1)]);
    expect(amounts(r)).toEqual([0, 6_500, 0, 2_000 + 6_600, 6_500 + 8_600]);
    expect(r.freeItemUsageDeltas).toEqual([{ benefitId: 'coffee', qtyUsed: 1 }]);
  });

  it('the quota spent, only the percentage is left', () => {
    const r = applyStaffBenefits(STAFF, used(2), [latte(1)]);
    expect(amounts(r)).toEqual([0, 0, 0, 2_000, 2_000]);
    expect(r.freeItemUsageDeltas).toEqual([]);
  });

  it('usage beyond the quota counts as none left, never as a negative', () => {
    const r = applyStaffBenefits(STAFF, used(9), [latte(1)]);
    expect(r.freeItemsSatang).toBe(0);
  });

  it('a quota runs across lines in cart order', () => {
    // Latte (฿65) and one of three americanos (฿60) free; the other two ฿120 × 30 % = ฿36.
    const r = applyStaffBenefits(STAFF, emptyBenefitUsage(), [latte(1), americano(3)]);
    expect(amounts(r)).toEqual([0, 12_500, 0, 3_600, 16_100]);
    expect(r.lineRelief).toEqual([6_500, 9_600]);
  });

  it('a category target covers its sub-categories (the item’s own category or its parent)', () => {
    const drinks = {
      ...coffeeQuota(3),
      id: 'drink',
      target: { kind: 'fnbCategory' as const, category: DRINKS },
    };
    const r = applyStaffBenefits({ freeItems: [drinks] }, emptyBenefitUsage(), [
      latte(1),
      juice(1),
      pizza(1),
    ]);
    expect(r.freeItemsSatang).toBe(6_500 + 5_500);
    expect(r.freeItemUsageDeltas).toEqual([{ benefitId: 'drink', qtyUsed: 2 }]);
  });

  it('two free items on one line never claim quota for a unit already given away', () => {
    // `coffee` takes one latte; `drink` asks for two but the line's remaining
    // ฿65 funds one, so it claims one — the prototype's cap (benefits.ts:126-145).
    const drinks = {
      ...coffeeQuota(5),
      id: 'drink',
      target: { kind: 'fnbCategory' as const, category: DRINKS },
    };
    const r = applyStaffBenefits({ freeItems: [coffeeQuota(1), drinks] }, emptyBenefitUsage(), [
      latte(2),
    ]);
    expect(r.freeItemsSatang).toBe(13_000);
    expect(r.freeItemUsageDeltas).toEqual([
      { benefitId: 'coffee', qtyUsed: 1 },
      { benefitId: 'drink', qtyUsed: 1 },
    ]);
  });

  it('Manager: coffees, then credit greedily, then 30 % of the rest', () => {
    // Lattes free (฿130); credit ฿500 takes pizza ฿220 and juice ฿55; nothing left for 30 %.
    const r = applyStaffBenefits(MANAGER, emptyBenefitUsage(), [latte(2), pizza(1), juice(1)]);
    expect(amounts(r)).toEqual([0, 13_000, 27_500, 0, 40_500]);
    expect(r.creditUsedDelta).toBe(27_500);
  });

  it('credit is what is left of the pool this period; the percentage shaves the overflow', () => {
    // ฿450 of ฿500 already used: ฿50 off the pizza, then 30 % of ฿170 = ฿51.
    const r = applyStaffBenefits(MANAGER, used(2, 45_000), [pizza(1)]);
    expect(amounts(r)).toEqual([0, 0, 5_000, 5_100, 10_100]);
    expect(r.creditUsedDelta).toBe(5_000);
  });

  it('credit scoped to a category spends only there', () => {
    const r = applyStaffBenefits(
      {
        credit: {
          amountSatang: 10_000,
          period: 'daily',
          target: { kind: 'fnbCategory', category: COFFEE },
        },
      },
      emptyBenefitUsage(),
      [pizza(1), latte(2)],
    );
    expect(r.creditSatang).toBe(10_000);
    expect(r.lineRelief).toEqual([0, 10_000]);
  });

  it('a standing percentage scoped to named items, and clamped to 0–100', () => {
    const items = { kind: 'menuItems' as const, menuItemIds: ['pizza'] };
    expect(
      applyStaffBenefits(
        { standingDiscount: { percent: 50, target: items } },
        emptyBenefitUsage(),
        [latte(1), pizza(1)],
      ).lineRelief,
    ).toEqual([0, 11_000]);
    expect(
      applyStaffBenefits({ standingDiscount: { percent: 150 } }, emptyBenefitUsage(), [pizza(1)])
        .discountSatang,
    ).toBe(22_000);
    expect(
      applyStaffBenefits({ standingDiscount: { percent: -5 } }, emptyBenefitUsage(), [pizza(1)])
        .discountSatang,
    ).toBe(0);
  });

  it('a target outside the cart relieves nothing', () => {
    const r = applyStaffBenefits(
      { freeItems: [{ ...coffeeQuota(), target: { kind: 'menuItems', menuItemIds: ['cake'] } }] },
      emptyBenefitUsage(),
      [latte(1)],
    );
    expect(r.totalReliefSatang).toBe(0);
  });

  it('rounds to the whole baht by default (Q8) and to the satang when told', () => {
    // ฿65 × 30 % = ฿19.50.
    expect(
      applyStaffBenefits({ standingDiscount: { percent: 30 } }, emptyBenefitUsage(), [latte(1)])
        .discountSatang,
    ).toBe(2_000);
    expect(
      applyStaffBenefits(
        { standingDiscount: { percent: 30 } },
        emptyBenefitUsage(),
        [latte(1)],
        DEFAULT_ROUNDING,
      ).discountSatang,
    ).toBe(1_950);
    // A free unit of a ฿100 line of three is ฿33.33…: ฿33 by default, ฿33.33 to the satang.
    const third = line('scone', [FOOD], 3, 0);
    third.lineTotal = 10_000;
    const free = { freeItems: [{ ...coffeeQuota(1), target: { kind: 'fnb' as const } }] };
    expect(applyStaffBenefits(free, emptyBenefitUsage(), [third]).freeItemsSatang).toBe(3_300);
    expect(
      applyStaffBenefits(free, emptyBenefitUsage(), [third], DEFAULT_ROUNDING).freeItemsSatang,
    ).toBe(3_333);
  });

  it('rounds an exact half-baht up — the one place the prototype’s float division differs', () => {
    // 70 % of ฿45 is ฿31.50 exactly. The prototype computes 45 × 0.7 =
    // 31.499999… and takes ฿31; this is ฿32, as a manual percentage is.
    const r = applyStaffBenefits({ standingDiscount: { percent: 70 } }, emptyBenefitUsage(), [
      line('cookie', [FOOD], 1, 45),
    ]);
    expect(r.discountSatang).toBe(3_200);
  });

  it('never takes more than a line has left, even when the baht rounding would', () => {
    // A ฿65.50 latte at 100 %: ฿65.50 rounds to ฿66, clamped to ฿65.50.
    const odd: BenefitLine = {
      itemId: 'latte',
      categoryIds: [COFFEE, DRINKS],
      qty: 1,
      lineTotal: 6_550,
    };
    const r = applyStaffBenefits({ standingDiscount: { percent: 100 } }, emptyBenefitUsage(), [
      odd,
    ]);
    expect(r.discountSatang).toBe(6_550);
  });

  it('reads only the usage it was given — an id like `constructor` starts at zero', () => {
    const r = applyStaffBenefits(
      { freeItems: [{ ...coffeeQuota(1), id: 'constructor' }] },
      emptyBenefitUsage(),
      [latte(1)],
    );
    expect(r.freeItemsSatang).toBe(6_500);
  });

  it('per-line relief sums to the total, and the result carries the engine version', () => {
    const r = applyStaffBenefits(MANAGER, used(1, 49_000), [
      latte(2),
      americano(1),
      pizza(2),
      juice(1),
    ]);
    expect(r.lineRelief.reduce((a, b) => a + b, 0)).toBe(r.totalReliefSatang);
    expect(r.totalReliefSatang).toBe(r.freeItemsSatang + r.creditSatang + r.discountSatang);
    expect(r.engineVersion).toBe(PRICING_ENGINE_VERSION);
  });
});

describe('profiles', () => {
  it('an override is the whole profile; without one the template is copied part by part', () => {
    const override: BenefitProfile = { standingDiscount: { percent: 10 } };
    expect(resolveEffectiveBenefitProfile(MANAGER, override)).toBe(override);
    expect(resolveEffectiveBenefitProfile(MANAGER, null)).toEqual({ ...MANAGER, comp: undefined });
    expect(isEmptyBenefitProfile(resolveEffectiveBenefitProfile(null, null))).toBe(true);
  });

  it('is empty only with nothing configured', () => {
    expect(isEmptyBenefitProfile({})).toBe(true);
    expect(isEmptyBenefitProfile({ comp: false, freeItems: [] })).toBe(true);
    expect(isEmptyBenefitProfile(OWNER)).toBe(false);
    expect(isEmptyBenefitProfile({ standingDiscount: { percent: 0 } })).toBe(false);
  });

  it('keys a period by the day or the month it was given', () => {
    expect(benefitPeriodKey('daily', '2026-10-07')).toBe('2026-10-07');
    expect(benefitPeriodKey('monthly', '2026-10-07')).toBe('2026-10');
  });

  it('matches a target the way the prototype’s menuItemMatchesTarget does', () => {
    const l = { itemId: 'latte', categoryIds: [COFFEE, DRINKS] };
    expect(benefitTargetMatches(l, { kind: 'everything' })).toBe(true);
    expect(benefitTargetMatches(l, { kind: 'fnb' })).toBe(true);
    expect(benefitTargetMatches(l, { kind: 'fnbCategory', category: DRINKS })).toBe(true);
    expect(benefitTargetMatches(l, { kind: 'fnbCategory', category: FOOD })).toBe(false);
    expect(benefitTargetMatches(l, { kind: 'menuItems', menuItemIds: ['latte'] })).toBe(true);
    expect(benefitTargetMatches(l, { kind: 'tickets' })).toBe(false);
    expect(benefitTargetMatches(l, { kind: 'merch' })).toBe(false);
  });
});

describe('BenefitProfileSchema', () => {
  const cat = '0199a2b4-0000-7000-8000-000000000001';
  const ok = {
    freeItems: [
      {
        id: 'coffee',
        label: 'Free coffee',
        target: { kind: 'fnbCategory', category: cat },
        quotaPerPeriod: 2,
        period: 'daily',
      },
    ],
    credit: { amountSatang: 50_000, period: 'monthly' },
    standingDiscount: { percent: 30, target: { kind: 'fnb' } },
  };

  it('accepts the seeded Manager template', () => {
    expect(BenefitProfileSchema.safeParse(ok).success).toBe(true);
  });

  it('refuses two free items under one id, which would share a quota', () => {
    const dup = { freeItems: [ok.freeItems[0], { ...ok.freeItems[0], label: 'Another' }] };
    expect(BenefitProfileSchema.safeParse(dup).success).toBe(false);
  });

  it('refuses a scope that matches nothing at the F&B station, and fields it does not know', () => {
    expect(
      BenefitProfileSchema.safeParse({
        standingDiscount: { percent: 10, target: { kind: 'tickets' } },
      }).success,
    ).toBe(false);
    expect(BenefitProfileSchema.safeParse({ ...ok, amountTHB: 500 }).success).toBe(false);
  });

  it('refuses a fractional satang, a zero quota and a percentage past 100', () => {
    expect(
      BenefitProfileSchema.safeParse({ credit: { amountSatang: 0.5, period: 'daily' } }).success,
    ).toBe(false);
    expect(
      BenefitProfileSchema.safeParse({ freeItems: [{ ...ok.freeItems[0], quotaPerPeriod: 0 }] })
        .success,
    ).toBe(false);
    expect(BenefitProfileSchema.safeParse({ standingDiscount: { percent: 101 } }).success).toBe(
      false,
    );
  });
});
