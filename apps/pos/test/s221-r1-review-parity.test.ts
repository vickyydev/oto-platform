import { describe, expect, it } from 'vitest';
import {
  applyStaffBenefits as platformApply,
  PRICING_ENGINE_VERSION,
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
 * SCRUM-218 review of lane I round 1: the platform engine against the
 * prototype's own `applyStaffBenefits` (`@/lib/benefits`, byte-identical to
 * imports/oto-pos/artifacts/oto-till/src/lib/benefits.ts), case by case.
 *
 * The builder's parity test sweeps whole-baht carts and whole-baht credit
 * only. This one goes after what that leaves out:
 *
 *   - satang-precision line totals (฿65.50 modifiers) and satang credit;
 *   - the rounding boundaries at the whole baht (x.49 / x.50 / x.51) for a
 *     free item's share of a line and for the standing percentage;
 *   - odd and fractional percentages (12.5, 33.33, 70, 99);
 *   - zero, negative and qty-0 lines, an all-zero cart, and combined benefits.
 *
 * "The same" is exact, except for two classes the engine's header names, and
 * each difference this file finds is checked to be one of them, line by line:
 *
 *   TIE    the prototype's float `remaining * (pct / 100)` lands a hair under
 *          an exact half-baht and rounds down; the platform rounds it up.
 *          Platform = prototype + ฿1 on that line.
 *   CLAMP  the prototype's whole-baht round-up exceeds a line's remaining
 *          satang (฿65.50 at 100 %); the platform caps the cut at what the
 *          line has left. Platform = what the line had left.
 *
 * Every other amount — comp, free items, credit, the usage claimed — must
 * agree to the satang.
 */

const CATEGORIES: MenuCategoryDef[] = [
  { id: 'drinks', name: 'Drinks', sortOrder: 0 },
  { id: 'drinks-coffee', name: 'Coffee', parentId: 'drinks', sortOrder: 0 },
  { id: 'food', name: 'Food', sortOrder: 1 },
];

const ITEMS: Array<{ id: string; category: string }> = [
  { id: 'latte', category: 'drinks-coffee' },
  { id: 'americano', category: 'drinks-coffee' },
  { id: 'juice', category: 'drinks' },
  { id: 'cake', category: 'food' },
];

const walk = (category: string): string[] => {
  const parent = CATEGORIES.find((c) => c.id === category)?.parentId;
  return parent ? [category, parent] : [category];
};

interface Line {
  item: string;
  qty: number;
  /** Satang. */
  satang: number;
}

const protoLine = (l: Line, i: number): FnbOrderLine => {
  const it = ITEMS.find((x) => x.id === l.item)!;
  const menuItem: MenuItem = {
    id: it.id,
    name: it.id,
    category: it.category,
    price: { weekday: l.satang / 100, weekend: l.satang / 100 },
  };
  return { id: `l${i}`, menuItem, qty: l.qty, selectedModifiers: [], lineTotal: l.satang / 100 };
};

const platformLine = (l: Line): BenefitLine => ({
  itemId: l.item,
  categoryIds: walk(ITEMS.find((x) => x.id === l.item)!.category),
  qty: l.qty,
  lineTotal: l.satang,
});

const protoProfile = (p: BenefitProfile): PrototypeProfile => ({
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

interface Usage {
  used?: Record<string, number>;
  creditUsedSatang?: number;
}

function both(profile: BenefitProfile, lines: Line[], usage: Usage = {}) {
  const proto = prototypeApply(
    protoProfile(profile),
    { freeItemsUsed: { ...(usage.used ?? {}) }, creditUsedTHB: (usage.creditUsedSatang ?? 0) / 100 },
    lines.map(protoLine),
    CATEGORIES,
  );
  const platform = platformApply(
    profile,
    { freeItemsUsed: { ...(usage.used ?? {}) }, creditUsedSatang: usage.creditUsedSatang ?? 0 },
    lines.map(platformLine),
  );
  const s = (baht: number) => Math.round(baht * 100);
  return {
    proto: {
      comp: s(proto.compedTHB),
      freeItems: s(proto.freeItemsTHB),
      credit: s(proto.creditTHB),
      discount: s(proto.discountTHB),
      total: s(proto.totalReliefTHB),
      usage: proto.freeItemUsageDeltas,
      creditUsed: s(proto.creditUsedDelta),
    },
    platform: {
      comp: platform.compedSatang,
      freeItems: platform.freeItemsSatang,
      credit: platform.creditSatang,
      discount: platform.discountSatang,
      total: platform.totalReliefSatang,
      usage: platform.freeItemUsageDeltas,
      creditUsed: platform.creditUsedDelta,
    },
    raw: platform,
  };
}

/** The platform result's own invariants, whatever the prototype says. */
function expectSane(lines: Line[], r: ReturnType<typeof platformApply>, label: string) {
  expect(r.engineVersion, label).toBe(PRICING_ENGINE_VERSION);
  expect(r.lineRelief.length, label).toBe(lines.length);
  const amounts = [
    r.compedSatang,
    r.freeItemsSatang,
    r.creditSatang,
    r.discountSatang,
    r.totalReliefSatang,
    r.creditUsedDelta,
    ...r.lineRelief,
  ];
  for (const a of amounts) expect(Number.isInteger(a), `${label}: ${a} is not whole satang`).toBe(true);
  expect(r.lineRelief.reduce((a, b) => a + b, 0), label).toBe(r.totalReliefSatang);
  expect(
    r.compedSatang + r.freeItemsSatang + r.creditSatang + r.discountSatang,
    label,
  ).toBe(r.totalReliefSatang);
  if (r.compedSatang === 0) {
    // Never more relief on a line than the line charged (a comp is the order).
    lines.forEach((l, i) => {
      expect(r.lineRelief[i]!, `${label} line ${i}`).toBeGreaterThanOrEqual(0);
      expect(r.lineRelief[i]!, `${label} line ${i}`).toBeLessThanOrEqual(Math.max(0, l.satang));
    });
  }
}

/**
 * Explain a discount-stage difference line by line: the remaining on each
 * line after free items and credit is the platform's own (its stages before
 * the percentage are asserted equal to the prototype's first), and each line
 * is run alone through the PROTOTYPE with only the percentage.
 */
function explainDiscount(profile: BenefitProfile, lines: Line[], usage: Usage) {
  const before = platformApply(
    { ...profile, standingDiscount: undefined },
    { freeItemsUsed: { ...(usage.used ?? {}) }, creditUsedSatang: usage.creditUsedSatang ?? 0 },
    lines.map(platformLine),
  );
  const pd = profile.standingDiscount!;
  const target = pd.target ?? ({ kind: 'fnb' } as BenefitTarget);
  const classes: Array<'tie' | 'clamp'> = [];
  let protoSum = 0;
  let platformSum = 0;
  lines.forEach((l, i) => {
    const left = l.satang - before.lineRelief[i]!;
    if (left <= 0) return;
    const one = both({ standingDiscount: { percent: pd.percent, target } }, [{ ...l, satang: left }]);
    protoSum += one.proto.discount;
    platformSum += one.platform.discount;
    if (one.platform.discount === one.proto.discount) return;
    const pct = Math.max(0, Math.min(100, pd.percent));
    const exactHalf = Math.abs(((left * pct) / 100) % 100 - 50) < 1e-6;
    if (exactHalf && one.platform.discount - one.proto.discount === 100) classes.push('tie');
    else if (one.proto.discount > left && one.platform.discount === left) classes.push('clamp');
    else throw new Error(`unexplained line difference: ${JSON.stringify({ l, left, pct, one })}`);
  });
  return { protoSum, platformSum, classes };
}

const coffee = (quota = 2, id = 'coffee'): NonNullable<BenefitProfile['freeItems']>[number] => ({
  id,
  label: 'Free coffee',
  target: { kind: 'fnbCategory', category: 'drinks-coffee' },
  quotaPerPeriod: quota,
  period: 'daily',
});

const L = (item: string, qty: number, baht: number): Line => ({
  item,
  qty,
  satang: Math.round(baht * 100),
});

interface Case {
  name: string;
  profile: BenefitProfile;
  lines: Line[];
  usage?: Usage;
}

// Each must match EXACTLY — none of them reaches a tie or a clamp.
const EXACT: Case[] = [
  { name: 'empty cart, comp', profile: { comp: true }, lines: [] },
  { name: 'all-zero cart, comp', profile: { comp: true }, lines: [L('latte', 2, 0), L('cake', 1, 0)] },
  {
    name: 'all-zero cart, every stage',
    profile: { freeItems: [coffee()], credit: { amountSatang: 50_000, period: 'monthly' }, standingDiscount: { percent: 30 } },
    lines: [L('latte', 1, 0)],
  },
  { name: 'comp: false is no comp', profile: { comp: false, standingDiscount: { percent: 30 } }, lines: [L('cake', 1, 125)] },
  {
    name: 'comp wins over everything else',
    profile: { comp: true, freeItems: [coffee()], credit: { amountSatang: 10_000, period: 'daily' }, standingDiscount: { percent: 30 } },
    lines: [L('latte', 2, 130), L('cake', 1, 125.5)],
  },
  {
    name: 'a negative line under a positive order (comp takes the net)',
    profile: { comp: true },
    lines: [L('cake', 1, 125), L('juice', 1, -20)],
  },
  {
    name: 'a negative line under a positive order (stages skip it)',
    profile: { freeItems: [coffee()], credit: { amountSatang: 3_000, period: 'daily' }, standingDiscount: { percent: 30 } },
    lines: [L('juice', 1, -20), L('latte', 2, 130), L('cake', 1, 125)],
  },
  { name: 'a net-negative order relieves nothing', profile: { comp: true }, lines: [L('cake', 1, 50), L('juice', 1, -60)] },
  {
    name: 'a qty-0 line: no free item, but credit and percent still reach it',
    profile: { freeItems: [{ ...coffee(), target: { kind: 'fnb' } }], credit: { amountSatang: 2_000, period: 'daily' }, standingDiscount: { percent: 30 } },
    lines: [L('cake', 0, 125), L('latte', 1, 65)],
  },
  { name: 'quota used past the quota', profile: { freeItems: [coffee(2)] }, lines: [L('latte', 3, 195)], usage: { used: { coffee: 5 } } },
  { name: 'usage under another id does not count', profile: { freeItems: [coffee(2)] }, lines: [L('latte', 3, 195)], usage: { used: { tea: 2 } } },
  { name: 'quota exactly the line', profile: { freeItems: [coffee(3)] }, lines: [L('latte', 3, 195)] },
  { name: 'quota across three lines', profile: { freeItems: [coffee(4)] }, lines: [L('latte', 1, 65), L('cake', 2, 250), L('americano', 2, 120), L('latte', 2, 130)] },
  {
    name: 'two free items, the first empties the line',
    profile: { freeItems: [coffee(5, 'a'), { ...coffee(5, 'b'), target: { kind: 'fnbCategory', category: 'drinks' } }] },
    lines: [L('latte', 2, 130), L('juice', 2, 110)],
  },
  { name: 'credit exactly the order', profile: { credit: { amountSatang: 19_000, period: 'monthly' } }, lines: [L('latte', 1, 65), L('cake', 1, 125)] },
  { name: 'credit larger than the order', profile: { credit: { amountSatang: 100_000, period: 'monthly' } }, lines: [L('latte', 1, 65), L('cake', 1, 125)] },
  { name: 'credit of ฿0', profile: { credit: { amountSatang: 0, period: 'monthly' }, standingDiscount: { percent: 30 } }, lines: [L('cake', 1, 125)] },
  { name: 'credit target not in the cart', profile: { credit: { amountSatang: 50_000, period: 'monthly', target: { kind: 'menuItems', menuItemIds: ['juice'] } } }, lines: [L('cake', 1, 125)] },
  { name: 'satang credit against a satang line', profile: { credit: { amountSatang: 3_325, period: 'daily' } }, lines: [L('latte', 1, 65.5), L('cake', 1, 125.25)] },
  { name: 'satang credit used', profile: { credit: { amountSatang: 50_000, period: 'monthly' } }, lines: [L('cake', 3, 375)], usage: { creditUsedSatang: 48_765 } },
  { name: 'everything, free + credit + 30 %, satang lines', profile: { freeItems: [coffee()], credit: { amountSatang: 4_050, period: 'monthly' }, standingDiscount: { percent: 30 } }, lines: [L('latte', 3, 196.5), L('cake', 1, 125.75), L('juice', 2, 110.1)] },
  // A free item's share of a line at the whole-baht boundary.
  { name: 'free share ฿50.49 rounds down', profile: { freeItems: [coffee(1)] }, lines: [L('latte', 2, 100.98)] },
  { name: 'free share ฿50.50 rounds up', profile: { freeItems: [coffee(1)] }, lines: [L('latte', 2, 101)] },
  { name: 'free share ฿50.51 rounds up', profile: { freeItems: [coffee(1)] }, lines: [L('latte', 2, 101.02)] },
  { name: 'free share of a third', profile: { freeItems: [coffee(2)] }, lines: [L('latte', 3, 100)] },
  { name: 'free share past the line is capped at the line', profile: { freeItems: [coffee(1)] }, lines: [L('latte', 1, 65.5)] },
  { name: 'free share after a first free item took most of the line', profile: { freeItems: [coffee(1, 'a'), coffee(1, 'b')] }, lines: [L('latte', 2, 131)] },
  // The standing percentage at the whole-baht boundary, at the park's 30 %.
  { name: '30 % of ฿101.63 (30.489) rounds down', profile: { standingDiscount: { percent: 30 } }, lines: [L('cake', 1, 101.63)] },
  { name: '30 % of ฿5 (1.5) rounds up', profile: { standingDiscount: { percent: 30 } }, lines: [L('cake', 1, 5)] },
  { name: '30 % of ฿101.70 (30.51) rounds up', profile: { standingDiscount: { percent: 30 } }, lines: [L('cake', 1, 101.7)] },
  { name: '12.5 % of ฿4 (0.5) rounds up', profile: { standingDiscount: { percent: 12.5 } }, lines: [L('cake', 1, 4)] },
  { name: '33.33 % of ฿300', profile: { standingDiscount: { percent: 33.33 } }, lines: [L('cake', 1, 300)] },
  { name: 'percent on a sub-baht remainder', profile: { standingDiscount: { percent: 30 } }, lines: [L('cake', 1, 0.4)] },
  { name: 'a big order', profile: { freeItems: [coffee(2)], credit: { amountSatang: 50_000, period: 'monthly' }, standingDiscount: { percent: 30 } }, lines: [L('latte', 200, 13_000), L('cake', 400, 50_000)] },
  { name: 'everything target, parent category, named items', profile: { freeItems: [{ ...coffee(2), target: { kind: 'fnbCategory', category: 'drinks' } }], credit: { amountSatang: 2_500, period: 'daily', target: { kind: 'menuItems', menuItemIds: ['cake'] } }, standingDiscount: { percent: 25, target: { kind: 'everything' } } }, lines: [L('juice', 1, 55), L('latte', 2, 130), L('cake', 1, 125)] },
];

describe('SCRUM-218 review — engine vs the prototype’s applyStaffBenefits', () => {
  it.each(EXACT)('$name', (c) => {
    const r = both(c.profile, c.lines, c.usage);
    expect(r.platform).toEqual(r.proto);
    expectSane(c.lines, r.raw, c.name);
  });

  it('the TIE class: 70 % of ฿45 is ฿31 in the prototype, ฿32 here — and nothing else moves', () => {
    const r = both({ standingDiscount: { percent: 70 } }, [L('cake', 1, 45)]);
    expect(r.proto.discount).toBe(3_100);
    expect(r.platform.discount).toBe(3_200);
    expect({ ...r.platform, discount: 0, total: 0 }).toEqual({ ...r.proto, discount: 0, total: 0 });
  });

  it('the CLAMP class: 100 % of ฿65.50 is ฿66 in the prototype (more than the bill), ฿65.50 here', () => {
    const r = both({ standingDiscount: { percent: 100 } }, [L('cake', 1, 65.5)]);
    expect(r.proto.discount).toBe(6_600);
    expect(r.platform.discount).toBe(6_550);
    expect(r.platform.total).toBeLessThanOrEqual(6_550);
  });

  it('a satang-precision sweep: every difference is a TIE or a CLAMP on the discount stage alone', () => {
    let seed = 0x218_2026;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)]!;
    const TARGETS: BenefitTarget[] = [
      { kind: 'fnb' },
      { kind: 'everything' },
      { kind: 'fnbCategory', category: 'drinks-coffee' },
      { kind: 'fnbCategory', category: 'drinks' },
      { kind: 'menuItems', menuItemIds: ['cake', 'juice'] },
    ];
    const PERCENTS = [0, 5, 10, 12.5, 15, 20, 25, 29, 30, 33.33, 35, 40, 50, 57, 70, 75, 82, 99, 100];
    const seen = { exact: 0, tie: 0, clamp: 0, freeItems: 0, credit: 0, discount: 0 };
    for (let n = 0; n < 20_000; n++) {
      const lines: Line[] = Array.from({ length: 1 + rnd(4) }, () => {
        const qty = rnd(10) === 0 ? 0 : 1 + rnd(4);
        // Satang prices: whole baht most of the time, a .25/.50/.75 or any satang otherwise.
        const unit = 1 + rnd(250);
        const frac = pick([0, 0, 0, 25, 50, 75, rnd(100)]);
        return { item: pick(ITEMS).id, qty, satang: (unit * 100 + frac) * Math.max(qty, 1) + (rnd(5) === 0 ? rnd(3_000) : 0) };
      });
      const profile: BenefitProfile = {};
      if (rnd(12) === 0) profile.comp = true;
      const items = rnd(3);
      if (items > 0) {
        profile.freeItems = Array.from({ length: items }, (_, i) => ({
          id: i === 0 ? 'coffee' : `f${i}`,
          label: 'Free',
          target: pick(TARGETS),
          quotaPerPeriod: 1 + rnd(4),
          period: pick(['daily', 'monthly'] as const),
        }));
      }
      if (rnd(2) === 0) {
        profile.credit = {
          amountSatang: rnd(60_000),
          period: 'monthly',
          ...(rnd(2) === 0 ? { target: pick(TARGETS) } : {}),
        };
      }
      if (rnd(4) !== 0) {
        profile.standingDiscount = {
          percent: pick(PERCENTS),
          ...(rnd(2) === 0 ? { target: pick(TARGETS) } : {}),
        };
      }
      const usage: Usage = {
        used: rnd(2) === 0 ? { coffee: rnd(4) } : {},
        creditUsedSatang: rnd(3) === 0 ? rnd(70_000) : 0,
      };
      const label = JSON.stringify({ n, profile, lines, usage });
      const r = both(profile, lines, usage);
      expectSane(lines, r.raw, label);
      if (r.platform.freeItems > 0) seen.freeItems++;
      if (r.platform.credit > 0) seen.credit++;
      if (r.platform.discount > 0) seen.discount++;
      // Comp, free items, credit and the usage claimed: always exact.
      expect(
        { comp: r.platform.comp, freeItems: r.platform.freeItems, credit: r.platform.credit, usage: r.platform.usage, creditUsed: r.platform.creditUsed },
        label,
      ).toEqual({ comp: r.proto.comp, freeItems: r.proto.freeItems, credit: r.proto.credit, usage: r.proto.usage, creditUsed: r.proto.creditUsed });
      if (r.platform.discount === r.proto.discount) {
        seen.exact++;
        continue;
      }
      // A difference: explain it line by line through the prototype itself.
      const why = explainDiscount(profile, lines, usage);
      expect(why.protoSum, `${label}: the per-line prototype run must add up to the whole`).toBe(r.proto.discount);
      expect(why.platformSum, label).toBe(r.platform.discount);
      expect(why.classes.length, label).toBeGreaterThan(0);
      for (const k of why.classes) seen[k]++;
    }
    // The sweep reaches every stage and both named classes.
    expect(seen.exact).toBeGreaterThan(15_000);
    expect(seen.freeItems).toBeGreaterThan(1_000);
    expect(seen.credit).toBeGreaterThan(1_000);
    expect(seen.discount).toBeGreaterThan(5_000);
    expect(seen.tie + seen.clamp).toBeGreaterThan(0);
    // 20,000 carts take about 3 s alone and more beside the full suite.
  }, 60_000);

  it('at the park’s seeded 30 %, whole-baht lines never differ in any cart (the classes stay away from the Q2 profiles)', () => {
    for (let baht = 0; baht <= 3_000; baht++) {
      const r = both({ standingDiscount: { percent: 30 } }, [L('cake', 1, baht)]);
      expect(r.platform.discount, `฿${baht}`).toBe(r.proto.discount);
    }
  });
});
