import { describe, expect, it } from 'vitest';
import {
  cartUnits,
  computeLineBreakdown,
  ledgerUnitComponentKey,
  ledgerUnitKindOf,
  priceCartLine,
  readTicketFreebies,
  resolveLineFreebies,
  socksIdsOf,
  ticketCartTaxInputs,
} from '../src/index';
import type { CartAddOn, PackagePricingShape, PricingContext, TicketCartLine, TicketFreebieRule } from '../src/index';

/**
 * SCRUM-768 — THE FREE ITEMS SET ON A TICKET IN ADMIN ARE APPLIED.
 *
 * Admin → Tickets saves "Free items in the rate" — a free adult, child or
 * add-on, for chosen tiers — and the engine used to ignore them, so the item
 * was charged. Each child ticket charged at the rate now carries the bundle,
 * at the weekday and the weekend price alike, and every free unit is a ฿0 row
 * of its own beside the row it came out of.
 */

const GRIP = '0190a0a0-0000-7000-8000-000000000768';
const SOCKS = 'socks-product';

const freebies: TicketFreebieRule[] = [
  { kind: 'adult', quantity: 1, tiers: ['tourist'] },
  { kind: 'child', quantity: 1, tiers: ['thai'] },
  { kind: 'addon', addOnId: GRIP, quantity: 1, tiers: ['tourist', 'thai'] },
];

const pkg = (withFreebies: readonly TicketFreebieRule[] | null = freebies): PackagePricingShape => ({
  prices: {
    tourist: { weekday: 50_000, weekend: 60_000 },
    thai: { weekday: 30_000, weekend: 35_000 },
    expat: { weekday: 40_000, weekend: 45_000 },
  },
  adultRules: { thai: { kind: 'set_price', price: { weekday: 10_000, weekend: 12_000 } } },
  freebies: withFreebies,
});

const ctx = (mode: 'weekday' | 'weekend'): PricingContext => ({
  mode,
  socks: { addOnId: SOCKS, price: 4_000, label: 'Regular Socks' },
});

const grip = (quantity: number, over: Partial<CartAddOn> = {}): CartAddOn => ({
  id: GRIP,
  name: 'Grip Socks',
  price: 9_000,
  quantity,
  ...over,
});

function line(over: Partial<TicketCartLine> & { tier: string }): TicketCartLine {
  const base: TicketCartLine = {
    id: 'line-1',
    packageId: 'pkg-1',
    package: pkg(),
    tier: over.tier,
    kids: 0,
    adults: 0,
    socks: 0,
    addOns: [],
    lineTotal: 0,
  };
  const built = { ...base, ...over };
  built.lineTotal = priceCartLine(built, ctx('weekday'));
  return built;
}

const rows = (l: TicketCartLine, mode: 'weekday' | 'weekend' = 'weekday') =>
  computeLineBreakdown(l, ctx(mode)).map((r) => ({ key: r.key, label: r.label, quantity: r.quantity, subtotal: r.subtotal }));

describe('a free adult (Tourist)', () => {
  it('lets one adult per paid child in free, weekday and weekend', () => {
    const l = line({ tier: 'tourist', kids: 2, adults: 3 });
    expect(priceCartLine(l, ctx('weekday'))).toBe(2 * 50_000 + 1 * 50_000);
    expect(priceCartLine(l, ctx('weekend'))).toBe(2 * 60_000 + 1 * 60_000);
    expect(rows(l)).toEqual([
      { key: 'kids', label: 'Kids', quantity: 2, subtotal: 100_000 },
      { key: 'adults', label: 'Adults', quantity: 1, subtotal: 50_000 },
      { key: 'adults-free', label: 'Adults (free)', quantity: 2, subtotal: 0 },
    ]);
  });

  it('frees no more adults than came, and none with no child ticket', () => {
    expect(priceCartLine(line({ tier: 'tourist', kids: 2, adults: 1 }), ctx('weekday'))).toBe(100_000);
    expect(priceCartLine(line({ tier: 'tourist', kids: 0, adults: 2 }), ctx('weekday'))).toBe(100_000);
  });

  it('is not given at a tier it was not set for', () => {
    // Thai adults pay the Thai set price; the free adult is Tourist only.
    expect(priceCartLine(line({ tier: 'thai', kids: 1, adults: 1 }), ctx('weekday'))).toBe(30_000 + 10_000);
    expect(priceCartLine(line({ tier: 'expat', kids: 1, adults: 1 }), ctx('weekend'))).toBe(45_000 + 45_000);
  });
});

describe('a free child (Thai)', () => {
  it('brings one more child free per paid child, weekday and weekend', () => {
    const l = line({ tier: 'thai', kids: 3 });
    expect(priceCartLine(l, ctx('weekday'))).toBe(2 * 30_000);
    expect(priceCartLine(l, ctx('weekend'))).toBe(2 * 35_000);
    expect(rows(l, 'weekend')).toEqual([
      { key: 'kids', label: 'Kids', quantity: 2, subtotal: 70_000 },
      { key: 'kids-free', label: 'Kids (free)', quantity: 1, subtotal: 0 },
    ]);
  });

  it('always charges one child on a line, so a single child is never free', () => {
    const l = line({ tier: 'thai', kids: 1 });
    expect(priceCartLine(l, ctx('weekday'))).toBe(30_000);
    expect(rows(l).map((r) => r.key)).toEqual(['kids']);
  });

  it('is not given at a tier it was not set for', () => {
    expect(priceCartLine(line({ tier: 'tourist', kids: 2 }), ctx('weekday'))).toBe(100_000);
  });
});

describe('a free add-on (Tourist and Thai)', () => {
  it('takes one of the add-on per paid child off, as its own ฿0 row under the add-on', () => {
    for (const tier of ['tourist', 'thai']) {
      const l = line({ tier, kids: 1, addOns: [grip(2)] });
      const kid = tier === 'tourist' ? 50_000 : 30_000;
      expect(priceCartLine(l, ctx('weekday'))).toBe(kid + 9_000);
      expect(rows(l).slice(1)).toEqual([
        { key: GRIP, label: 'Grip Socks', quantity: 1, subtotal: 9_000 },
        { key: GRIP, label: 'Grip Socks (free)', quantity: 1, subtotal: 0 },
      ]);
    }
  });

  it('frees only what the line carries: the till does not add the item by itself', () => {
    expect(rows(line({ tier: 'tourist', kids: 2 })).map((r) => r.key)).toEqual(['kids']);
    const l = line({ tier: 'tourist', kids: 2, addOns: [grip(1)] });
    expect(rows(l).slice(1)).toEqual([{ key: GRIP, label: 'Grip Socks (free)', quantity: 1, subtotal: 0 }]);
    expect(priceCartLine(l, ctx('weekday'))).toBe(100_000);
  });

  it('is not given at a tier it was not set for', () => {
    expect(priceCartLine(line({ tier: 'expat', kids: 1, addOns: [grip(1)] }), ctx('weekday'))).toBe(40_000 + 9_000);
  });

  it('splits a sized add-on, the free units from the first sizes added', () => {
    const sized = grip(3, {
      variantBreakdown: [
        { variantId: 's', variantLabel: 'S', quantity: 1 },
        { variantId: 'm', variantLabel: 'M', quantity: 2 },
      ],
    });
    const l = line({ tier: 'tourist', kids: 1, addOns: [sized] });
    const addOnRows = computeLineBreakdown(l, ctx('weekday')).filter((r) => r.kind === 'addon');
    expect(addOnRows.map((r) => [r.label, r.quantity, r.subtotal, r.variantBreakdown])).toEqual([
      ['Grip Socks (2×M)', 2, 18_000, [{ variantId: 'm', variantLabel: 'M', quantity: 2 }]],
      ['Grip Socks (1×S) (free)', 1, 0, [{ variantId: 's', variantLabel: 'S', quantity: 1 }]],
    ]);
  });

  it('frees the socks the line counts when the bundled add-on is the socks', () => {
    const withSocks = pkg([{ kind: 'addon', addOnId: SOCKS, quantity: 1, tiers: ['tourist'] }]);
    const l = line({ tier: 'tourist', kids: 2, socks: 3, package: withSocks });
    expect(priceCartLine(l, ctx('weekday'))).toBe(100_000 + 4_000);
    expect(rows(l).slice(1)).toEqual([
      { key: 'socks', label: 'Regular Socks', quantity: 1, subtotal: 4_000 },
      { key: 'socks-free', label: 'Regular Socks (free)', quantity: 2, subtotal: 0 },
    ]);
  });
});

describe('what stays as it was', () => {
  it('a ticket with no free items renders and prices exactly as before', () => {
    const plain = line({ tier: 'tourist', kids: 2, adults: 1, socks: 1, addOns: [grip(2)], package: pkg(null) });
    const empty = { ...plain, package: pkg([]) };
    expect(computeLineBreakdown(empty, ctx('weekday'))).toEqual(computeLineBreakdown(plain, ctx('weekday')));
    expect(priceCartLine(plain, ctx('weekday'))).toBe(100_000 + 50_000 + 4_000 + 18_000);
    expect(rows(plain).map((r) => r.key)).toEqual(['kids', 'adults', 'socks', GRIP]);
  });

  it("an adult rule's free adults come first, the bundle on top of them", () => {
    const both = pkg([{ kind: 'adult', quantity: 1, tiers: [] }]);
    both.adultRules = { tourist: { kind: 'free_adults', freeAdults: 1, overflow: 'same_as_kid' } };
    const l = line({ tier: 'tourist', kids: 1, adults: 3, package: both });
    expect(rows(l)).toEqual([
      { key: 'kids', label: 'Kids', quantity: 1, subtotal: 50_000 },
      { key: 'adults', label: 'Adults', quantity: 1, subtotal: 50_000 },
      { key: 'adults-free', label: 'Adults (free)', quantity: 2, subtotal: 0 },
    ]);
  });
});

describe('the ledger and the tax bases', () => {
  it('files each free unit as a ฿0 line of its own kind, and the bases still sum to the line', () => {
    const l = line({ tier: 'thai', kids: 3, addOns: [grip(1)] });
    const units = cartUnits([l], ctx('weekday'));
    expect(units.map((u) => [ledgerUnitKindOf(u), ledgerUnitComponentKey(u), u.base])).toEqual([
      ['kids', 'kids', 60_000],
      ['kids', 'kids-free', 0],
      ['addon', GRIP, 0],
    ]);
    const bases = ticketCartTaxInputs([l], ctx('weekday')).reduce((sum, c) => sum + c.base, 0);
    expect(bases).toBe(l.lineTotal);
  });
});

describe('reading the stored free items', () => {
  it('keeps what Admin saves and drops what it cannot read', () => {
    expect(readTicketFreebies(null)).toBeNull();
    expect(readTicketFreebies([])).toBeNull();
    expect(
      readTicketFreebies([
        { id: 'fb-1', kind: 'child', quantity: 1, tiers: ['thai'], future: { retained: true } },
        { id: 'fb-2', kind: 'addon', quantity: 1, tiers: ['thai'] },
        { id: 'fb-3', kind: 'adult', quantity: 0, tiers: ['thai'] },
        'nonsense',
      ]),
    ).toEqual([{ id: 'fb-1', kind: 'child', quantity: 1, tiers: ['thai'] }]);
  });

  it('counts nothing for a line at a tier no free item names', () => {
    expect(
      resolveLineFreebies(pkg(), 'expat', { kids: 2, socks: 0, addOns: [{ id: GRIP, quantity: 2 }] }, 2, SOCKS),
    ).toEqual({ paidKids: 2, freeKids: 0, freeAdults: 0, freeSocks: 0, freeAddOns: [0] });
  });
});

/**
 * SCRUM-768 follow-up — THE SOCKS COUNTER AND A FREE REGULAR SOCKS.
 *
 * The till names its counter's socks by the prototype's `a-socks`, while Admin
 * saves a free Regular Socks under the branch's socks product (`AO-SOCKS`).
 * Each engine names that product beside the counter's id, so the free item
 * comes off the counter's socks; a sale with no socks prices as before.
 */
describe('a free Regular Socks saved under the socks product, on the socks counter', () => {
  const PRODUCT = '0190a0a0-0000-7000-8000-0000000005c5';
  const counter = (mode: 'weekday' | 'weekend', productId?: string | null): PricingContext => ({
    mode,
    socks: { addOnId: 'a-socks', price: 5_000, label: 'Regular Socks', ...(productId !== undefined ? { productId } : {}) },
  });
  const freeSocks = pkg([{ kind: 'addon', addOnId: PRODUCT, quantity: 1, tiers: ['tourist'] }]);
  const family = (over: Partial<TicketCartLine> = {}): TicketCartLine => ({
    id: 'line-socks',
    packageId: 'pkg-1',
    package: freeSocks,
    tier: 'tourist',
    kids: 2,
    adults: 0,
    socks: 2,
    addOns: [],
    lineTotal: 0,
    ...over,
  });
  const socksRows = (l: TicketCartLine, c: PricingContext) =>
    computeLineBreakdown(l, c)
      .filter((r) => r.kind === 'socks')
      .map((r) => [r.key, r.label, r.quantity, r.unitPrice, r.subtotal]);

  it('frees the counter socks the bundle names, at the weekday and the weekend price alike', () => {
    for (const mode of ['weekday', 'weekend'] as const) {
      const c = counter(mode, PRODUCT);
      const kid = mode === 'weekday' ? 50_000 : 60_000;
      // One free sock per paid child: both socks on the counter are free.
      expect(priceCartLine(family(), c)).toBe(2 * kid);
      expect(socksRows(family(), c)).toEqual([['socks-free', 'Regular Socks (free)', 2, 0, 0]]);
      // One child brings one free sock; the second is charged at the socks price.
      expect(priceCartLine(family({ kids: 1 }), c)).toBe(kid + 5_000);
      expect(socksRows(family({ kids: 1 }), c)).toEqual([
        ['socks', 'Regular Socks', 1, 5_000, 5_000],
        ['socks-free', 'Regular Socks (free)', 1, 0, 0],
      ]);
    }
  });

  it('spends the allowance on the counter first, then on the same socks from the add-on grid', () => {
    const c = counter('weekday', PRODUCT);
    const both = family({ kids: 1, socks: 1, addOns: [{ id: PRODUCT, name: 'Regular Socks', price: 5_000, quantity: 1 }] });
    expect(priceCartLine(both, c)).toBe(50_000 + 5_000);
    expect(computeLineBreakdown(both, c).map((r) => [r.key, r.quantity, r.subtotal])).toEqual([
      ['kids', 1, 50_000],
      ['socks-free', 1, 0],
      [PRODUCT, 1, 5_000],
    ]);
  });

  it('charges every sock where the product is not named, or at a tier the bundle leaves out', () => {
    // A till or box on the earlier release names no socks product.
    expect(socksRows(family({ kids: 1 }), counter('weekday'))).toEqual([['socks', 'Regular Socks', 2, 5_000, 10_000]]);
    expect(socksRows(family({ kids: 1 }), counter('weekday', null))).toEqual([['socks', 'Regular Socks', 2, 5_000, 10_000]]);
    expect(socksRows(family({ tier: 'expat' }), counter('weekday', PRODUCT))).toEqual([
      ['socks', 'Regular Socks', 2, 5_000, 10_000],
    ]);
  });

  it('prices a sale with no socks exactly as it did before the product was named', () => {
    const noSocks = family({ socks: 0, adults: 1, addOns: [grip(2)] });
    expect(priceCartLine(noSocks, counter('weekday', PRODUCT))).toBe(priceCartLine(noSocks, counter('weekday')));
    expect(computeLineBreakdown(noSocks, counter('weekend', PRODUCT))).toEqual(
      computeLineBreakdown(noSocks, counter('weekend')),
    );
  });

  it('names each id once', () => {
    expect(socksIdsOf({ addOnId: 'a-socks', price: 0, label: 'Regular Socks', productId: PRODUCT })).toEqual(['a-socks', PRODUCT]);
    expect(socksIdsOf({ addOnId: PRODUCT, price: 0, label: 'Regular Socks', productId: PRODUCT })).toEqual([PRODUCT]);
    expect(socksIdsOf({ addOnId: 'a-socks', price: 0, label: 'Regular Socks' })).toEqual(['a-socks']);
    expect(
      resolveLineFreebies(freeSocks, 'tourist', { kids: 3, socks: 5, addOns: [] }, 0, ['a-socks', PRODUCT, PRODUCT]).freeSocks,
    ).toBe(3);
  });
});
