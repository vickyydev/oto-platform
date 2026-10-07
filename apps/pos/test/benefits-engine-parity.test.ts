import { describe, expect, it } from 'vitest';
import {
  applyStaffBenefits as platformApply,
  type BenefitLine,
  type BenefitProfile,
  type BenefitTarget,
} from '@oto/shared';
import { applyStaffBenefits as prototypeApply } from '@/lib/benefits';
import type {
  BenefitProfile as PrototypeProfile,
  DiscountTarget,
  FnbOrderLine,
  MenuCategoryDef,
  MenuItem,
} from '@/types';

/**
 * S2-21 round 1 acceptance — "the same cart, profile and usage give the same
 * four amounts as `applyStaffBenefits`".
 *
 * `@/lib/benefits` is the prototype's engine, byte for byte
 * (imports/oto-pos/artifacts/oto-till/src/lib/benefits.ts). Every cart below
 * is run through it in baht and through the platform's engine
 * (`packages/shared/src/benefits.ts`) in satang, and the comp, free-item,
 * credit and standing-discount amounts, the total and the usage each claims
 * must agree to the satang.
 *
 * WHAT "THE SAME" MEANS, stated so nothing is loosened silently:
 *
 *   - EXACT for every cart, profile and usage, with one named class:
 *   - THE EXACT HALF-BAHT. The prototype rounds a standing percentage as
 *     `Math.round(remaining * (pct / 100))`, dividing first, so for some
 *     percentages an exact half-baht arrives a hair below .5 and rounds down
 *     (70 % of ฿45 = ฿31.50 → ฿31). The platform rounds the exact value
 *     half-up (฿32), as manual percentage discounts already do. The last test
 *     enumerates the class and proves it is the only difference: never more
 *     than ฿1, always up, only at an exact half-baht, and never at any
 *     percentage the park uses (the seeded 30 %, nor 5, 10, 15, 20, 25, 40,
 *     50, 75 or 100). The sweep uses those percentages and so is exact.
 */

// --- The menu, both ways ----------------------------------------------------------

const CATEGORIES: MenuCategoryDef[] = [
  { id: 'drinks', name: 'Drinks', sortOrder: 0 },
  { id: 'drinks-coffee', name: 'Coffee', parentId: 'drinks', sortOrder: 0 },
  { id: 'food', name: 'Food', sortOrder: 1 },
  { id: 'food-mains', name: 'Mains', parentId: 'food', sortOrder: 0 },
];

interface Dish {
  id: string;
  category: string;
  baht: number;
}

const MENU: Dish[] = [
  { id: 'latte', category: 'drinks-coffee', baht: 65 },
  { id: 'americano', category: 'drinks-coffee', baht: 60 },
  { id: 'juice', category: 'drinks', baht: 55 },
  { id: 'pizza', category: 'food-mains', baht: 220 },
  { id: 'fries', category: 'food', baht: 90 },
  { id: 'water', category: 'drinks', baht: 0 },
  { id: 'cake', category: 'food', baht: 125 },
];

const categoryWalk = (category: string): string[] => {
  const parent = CATEGORIES.find((c) => c.id === category)?.parentId;
  return parent ? [category, parent] : [category];
};

interface CartLine {
  dish: Dish;
  qty: number;
  /** Baht; the price × qty unless a case says otherwise (a modifier, say). */
  lineTotal: number;
}

const toPrototypeLine = (l: CartLine, i: number): FnbOrderLine => {
  const menuItem: MenuItem = {
    id: l.dish.id,
    name: l.dish.id,
    category: l.dish.category,
    price: { weekday: l.dish.baht, weekend: l.dish.baht },
  };
  return { id: `line-${i}`, menuItem, qty: l.qty, selectedModifiers: [], lineTotal: l.lineTotal };
};

const toPlatformLine = (l: CartLine): BenefitLine => ({
  itemId: l.dish.id,
  categoryIds: categoryWalk(l.dish.category),
  qty: l.qty,
  lineTotal: Math.round(l.lineTotal * 100),
});

/** The platform profile, in satang, the prototype's in baht. */
const toPrototypeProfile = (p: BenefitProfile): PrototypeProfile => ({
  ...(p.comp !== undefined ? { comp: p.comp } : {}),
  ...(p.freeItems
    ? { freeItems: p.freeItems.map((f) => ({ ...f, target: f.target as DiscountTarget })) }
    : {}),
  ...(p.credit
    ? {
        credit: {
          amountTHB: p.credit.amountSatang / 100,
          period: p.credit.period,
          ...(p.credit.target ? { target: p.credit.target as DiscountTarget } : {}),
        },
      }
    : {}),
  ...(p.standingDiscount ? { standingDiscount: { ...p.standingDiscount } } : {}),
});

interface Case {
  name: string;
  profile: BenefitProfile;
  cart: CartLine[];
  coffeeUsed?: number;
  creditUsedBaht?: number;
}

function compare(c: Case) {
  const proto = prototypeApply(
    toPrototypeProfile(c.profile),
    {
      freeItemsUsed: c.coffeeUsed ? { coffee: c.coffeeUsed } : {},
      creditUsedTHB: c.creditUsedBaht ?? 0,
    },
    c.cart.map(toPrototypeLine),
    CATEGORIES,
  );
  const platform = platformApply(
    c.profile,
    {
      freeItemsUsed: c.coffeeUsed ? { coffee: c.coffeeUsed } : {},
      creditUsedSatang: (c.creditUsedBaht ?? 0) * 100,
    },
    c.cart.map(toPlatformLine),
  );
  return {
    prototype: {
      comp: Math.round(proto.compedTHB * 100),
      freeItems: Math.round(proto.freeItemsTHB * 100),
      credit: Math.round(proto.creditTHB * 100),
      discount: Math.round(proto.discountTHB * 100),
      total: Math.round(proto.totalReliefTHB * 100),
      freeItemUsage: proto.freeItemUsageDeltas,
      creditUsed: Math.round(proto.creditUsedDelta * 100),
    },
    platform: {
      comp: platform.compedSatang,
      freeItems: platform.freeItemsSatang,
      credit: platform.creditSatang,
      discount: platform.discountSatang,
      total: platform.totalReliefSatang,
      freeItemUsage: platform.freeItemUsageDeltas,
      creditUsed: platform.creditUsedDelta,
    },
  };
}

// --- The prototype's own profiles -------------------------------------------------

const coffee = (quotaPerPeriod = 2) => ({
  id: 'coffee',
  label: 'Free coffee',
  target: { kind: 'fnbCategory', category: 'drinks-coffee' } as BenefitTarget,
  quotaPerPeriod,
  period: 'daily' as const,
});

/** `seedRoleBenefitTemplates` (catalogStore.ts:802-841), the Q2 amounts. */
const OWNER: BenefitProfile = { comp: true };
const MANAGER: BenefitProfile = {
  freeItems: [coffee()],
  credit: { amountSatang: 50_000, period: 'monthly' },
  standingDiscount: { percent: 30, target: { kind: 'fnb' } },
};
const STAFF: BenefitProfile = {
  freeItems: [coffee()],
  standingDiscount: { percent: 30, target: { kind: 'fnb' } },
};
/** The plan's named fixture: Nok, the Staff template with four coffees. */
const NOK: BenefitProfile = { ...STAFF, freeItems: [coffee(4)] };

const dish = (id: string) => MENU.find((d) => d.id === id)!;
const of = (id: string, qty: number, lineTotal?: number): CartLine => ({
  dish: dish(id),
  qty,
  lineTotal: lineTotal ?? dish(id).baht * qty,
});

const CASES: Case[] = [
  { name: 'empty profile', profile: {}, cart: [of('latte', 1), of('pizza', 1)] },
  { name: 'empty cart', profile: MANAGER, cart: [] },
  { name: 'a ฿0 order, comped', profile: OWNER, cart: [of('water', 2)] },
  {
    name: 'Owner comps everything',
    profile: OWNER,
    cart: [of('latte', 2), of('pizza', 1), of('cake', 1)],
  },
  { name: 'Staff: two coffees then 30 %', profile: STAFF, cart: [of('latte', 2), of('pizza', 1)] },
  {
    name: 'Staff, one coffee used',
    profile: STAFF,
    cart: [of('latte', 2), of('pizza', 1)],
    coffeeUsed: 1,
  },
  { name: 'Staff, quota spent', profile: STAFF, cart: [of('latte', 3)], coffeeUsed: 2 },
  { name: 'Staff, quota across lines', profile: STAFF, cart: [of('latte', 1), of('americano', 3)] },
  { name: 'Staff, no coffee in the cart', profile: STAFF, cart: [of('juice', 1), of('fries', 2)] },
  {
    name: 'Nok: four coffees',
    profile: NOK,
    cart: [of('latte', 3), of('americano', 2), of('cake', 1)],
  },
  { name: 'Nok, three used', profile: NOK, cart: [of('latte', 3)], coffeeUsed: 3 },
  {
    name: 'Manager: coffees, credit, 30 %',
    profile: MANAGER,
    cart: [of('latte', 2), of('pizza', 1), of('juice', 1)],
  },
  {
    name: 'Manager, credit nearly spent',
    profile: MANAGER,
    cart: [of('pizza', 2), of('latte', 1)],
    coffeeUsed: 2,
    creditUsedBaht: 450,
  },
  { name: 'Manager, credit spent', profile: MANAGER, cart: [of('fries', 3)], creditUsedBaht: 500 },
  {
    name: 'Manager, credit overspent',
    profile: MANAGER,
    cart: [of('fries', 1)],
    creditUsedBaht: 900,
  },
  {
    name: 'a line with a modifier (lineTotal above price × qty)',
    profile: STAFF,
    cart: [of('latte', 2, 160), of('cake', 1)],
  },
  {
    name: 'two free items on one line',
    profile: {
      freeItems: [
        coffee(1),
        { ...coffee(5), id: 'drink', target: { kind: 'fnbCategory', category: 'drinks' } },
      ],
    },
    cart: [of('latte', 2), of('juice', 1)],
  },
  {
    name: 'a parent category covers its sub-category',
    profile: {
      freeItems: [{ ...coffee(3), id: 'food', target: { kind: 'fnbCategory', category: 'food' } }],
    },
    cart: [of('pizza', 1), of('fries', 1), of('latte', 1)],
  },
  {
    name: 'named items, monthly',
    profile: {
      freeItems: [
        {
          ...coffee(1),
          id: 'cake',
          period: 'monthly',
          target: { kind: 'menuItems', menuItemIds: ['cake'] },
        },
      ],
      standingDiscount: {
        percent: 50,
        target: { kind: 'menuItems', menuItemIds: ['cake', 'fries'] },
      },
    },
    cart: [of('cake', 2), of('fries', 1), of('latte', 1)],
  },
  {
    name: 'credit scoped to coffee',
    profile: {
      credit: {
        amountSatang: 10_000,
        period: 'daily',
        target: { kind: 'fnbCategory', category: 'drinks-coffee' },
      },
    },
    cart: [of('pizza', 1), of('latte', 2)],
  },
  {
    name: 'everything',
    profile: { standingDiscount: { percent: 25, target: { kind: 'everything' } } },
    cart: [of('pizza', 1), of('latte', 1)],
  },
  {
    name: 'percentage clamped high',
    profile: { standingDiscount: { percent: 150 } },
    cart: [of('pizza', 1)],
  },
  {
    name: 'percentage clamped low',
    profile: { standingDiscount: { percent: -10 } },
    cart: [of('pizza', 1)],
  },
  { name: 'a ฿0 line among others', profile: STAFF, cart: [of('water', 1), of('latte', 1)] },
  {
    name: 'a third of a line',
    profile: {
      freeItems: [{ ...coffee(1), target: { kind: 'fnb' } }],
      standingDiscount: { percent: 30 },
    },
    cart: [of('cake', 3, 100)],
  },
];

describe('the platform engine gives the prototype’s four amounts', () => {
  it.each(CASES)('$name', (c) => {
    const { prototype, platform } = compare(c);
    expect(platform).toEqual(prototype);
  });

  it('over a seeded sweep of carts, profiles and usage', () => {
    // A small LCG: the same 20,000 cases on every run.
    let seed = 0x5eed2026;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)]!;
    const PERCENTS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
    const TARGETS: BenefitTarget[] = [
      { kind: 'fnb' },
      { kind: 'everything' },
      { kind: 'fnbCategory', category: 'drinks-coffee' },
      { kind: 'fnbCategory', category: 'drinks' },
      { kind: 'fnbCategory', category: 'food' },
      { kind: 'menuItems', menuItemIds: ['latte', 'cake'] },
    ];
    const randomProfile = (): BenefitProfile => {
      const shape = rnd(6);
      if (shape === 0) return pick([OWNER, MANAGER, STAFF, NOK]);
      const p: BenefitProfile = {};
      if (rnd(8) === 0) p.comp = true;
      const items = rnd(3);
      if (items > 0) {
        p.freeItems = Array.from({ length: items }, (_, i) => ({
          id: i === 0 ? 'coffee' : `item-${i}`,
          label: 'Free',
          target: pick(TARGETS),
          quotaPerPeriod: 1 + rnd(4),
          period: pick(['daily', 'monthly'] as const),
        }));
      }
      if (rnd(2) === 0) {
        p.credit = {
          amountSatang: rnd(1001) * 100,
          period: 'monthly',
          ...(rnd(2) === 0 ? { target: pick(TARGETS) } : {}),
        };
      }
      if (rnd(3) !== 0) {
        p.standingDiscount = {
          percent: pick(PERCENTS),
          ...(rnd(2) === 0 ? { target: pick(TARGETS) } : {}),
        };
      }
      return p;
    };
    let compared = 0;
    // Each stage has to be exercised, or the sweep proves nothing about it.
    const stagesSeen = { comp: 0, freeItems: 0, credit: 0, discount: 0 };
    for (let n = 0; n < 20_000; n++) {
      const cart = Array.from({ length: 1 + rnd(5) }, () => {
        const d = pick(MENU);
        const qty = 1 + rnd(4);
        // Now and then a modifier on top of the price.
        return { dish: d, qty, lineTotal: d.baht * qty + (rnd(4) === 0 ? 10 * rnd(5) * qty : 0) };
      });
      const c: Case = {
        name: `sweep ${n}`,
        profile: randomProfile(),
        cart,
        coffeeUsed: rnd(4),
        creditUsedBaht: rnd(3) === 0 ? rnd(700) : 0,
      };
      const { prototype, platform } = compare(c);
      expect(platform, JSON.stringify(c)).toEqual(prototype);
      compared++;
      if (prototype.comp > 0) stagesSeen.comp++;
      if (prototype.freeItems > 0) stagesSeen.freeItems++;
      if (prototype.credit > 0) stagesSeen.credit++;
      if (prototype.discount > 0) stagesSeen.discount++;
    }
    expect(compared).toBe(20_000);
    for (const [stage, seen] of Object.entries(stagesSeen))
      expect(seen, stage).toBeGreaterThan(500);
  });

  it('differs only at an exact half-baht the prototype’s float division rounds down', () => {
    const differences: Array<{
      remaining: number;
      percent: number;
      prototype: number;
      platform: number;
    }> = [];
    for (let remaining = 1; remaining <= 2_000; remaining++) {
      for (let percent = 0; percent <= 100; percent++) {
        const { prototype, platform } = compare({
          name: 'tie',
          profile: { standingDiscount: { percent } },
          cart: [{ dish: dish('cake'), qty: 1, lineTotal: remaining }],
        });
        if (platform.discount !== prototype.discount) {
          differences.push({
            remaining,
            percent,
            prototype: prototype.discount,
            platform: platform.discount,
          });
        }
      }
    }
    // Real, and every one of the same kind.
    expect(differences.length).toBeGreaterThan(0);
    for (const d of differences) {
      // An exact half-baht: remaining × percent / 100 ends in .5.
      expect((d.remaining * d.percent) % 100, JSON.stringify(d)).toBe(50);
      // The platform rounded it up, the prototype down, by ฿1.
      expect(d.platform - d.prototype, JSON.stringify(d)).toBe(100);
    }
    // Never at a percentage the park uses.
    const used = new Set([0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100]);
    expect(differences.filter((d) => used.has(d.percent))).toEqual([]);
  });
});
