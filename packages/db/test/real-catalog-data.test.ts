import { describe, expect, it } from 'vitest';
import { CodeSchema, MenuCategoryBodySchema, MenuItemBodySchema } from '@oto/shared';
import {
  buildParkCatalog,
  FREE_DRINK_LINES,
  MENU_LINES,
  PARKS,
  PRINTED_LINE_COUNTS,
  PRINTED_SHOP_COUNTS,
  REAL_CATEGORIES,
  SHOP_LINES,
  SPECIAL_LINES,
  type Park,
} from '../src/seed/real-catalog/index';

/**
 * The real till catalogue's data (2026-11-09), checked against the documents it
 * was transcribed from, without a database.
 *
 * The expected counts are the transcription's own table (catalog-work
 * menus-diff.md, "Item counts per section"), written out here so the data
 * files cannot drift from it without this failing.
 */
const TRANSCRIBED_COUNTS: Record<Park, Record<string, number>> = {
  central: {
    'CAT-BREAKFAST': 9, 'CAT-SIDES': 18, 'CAT-SHARING': 4, 'CAT-SALADS': 6, 'CAT-SOUP': 1,
    'CAT-PASTA': 4, 'CAT-PIZZA': 9, 'CAT-MAINS': 8, 'CAT-ASIAN-FOOD': 7, 'CAT-KIDS': 8,
    'CAT-DESSERTS': 2, 'CAT-COFFEE': 7, 'CAT-ICED-COFFEE': 6, 'CAT-CHOCOLATE': 2, 'CAT-SODA': 2,
    'CAT-SMOOTHIES': 3, 'CAT-JUICE': 2, 'CAT-TEA-POT': 5, 'CAT-SOFT-DRINKS': 7,
    'CAT-KIDS-JUICE': 4, 'CAT-WINE': 4, 'CAT-BEER': 1,
  },
  chalong: {
    'CAT-BREAKFAST': 8, 'CAT-SIDES': 18, 'CAT-SHARING': 4, 'CAT-SALADS': 6, 'CAT-SOUP': 1,
    'CAT-PASTA': 4, 'CAT-PIZZA': 9, 'CAT-MAINS': 7, 'CAT-ASIAN-FOOD': 7, 'CAT-KIDS': 7,
    'CAT-DESSERTS': 2, 'CAT-COFFEE': 7, 'CAT-ICED-COFFEE': 6, 'CAT-CHOCOLATE': 2, 'CAT-SODA': 2,
    'CAT-SMOOTHIES': 3, 'CAT-JUICE': 2, 'CAT-TEA-POT': 5, 'CAT-SOFT-DRINKS': 7,
    'CAT-KIDS-JUICE': 4, 'CAT-WINE': 4, 'CAT-BEER': 1,
  },
};

const linesAt = (park: Park) => MENU_LINES.filter((l) => l.numbers[park] !== undefined);

describe('the printed menus', () => {
  it.each(PARKS)('%s: every printed section has the transcribed number of lines', (park) => {
    const counted: Record<string, number> = {};
    for (const l of linesAt(park)) counted[l.category] = (counted[l.category] ?? 0) + 1;
    expect(counted).toEqual(TRANSCRIBED_COUNTS[park]);
    expect(PRINTED_LINE_COUNTS[park]).toEqual(TRANSCRIBED_COUNTS[park]);
  });

  it('holds 119 lines at Central Floresta and 116 at Robinson Chalong', () => {
    expect(linesAt('central')).toHaveLength(119);
    expect(linesAt('chalong')).toHaveLength(116);
  });

  it('prints each number once per park', () => {
    for (const park of PARKS) {
      const numbers = linesAt(park).map((l) => l.numbers[park]);
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it('carries only the three lines Chalong does not print', () => {
    const centralOnly = MENU_LINES.filter((l) => l.numbers.chalong === undefined).map((l) => [l.numbers.central, l.name]);
    expect(centralOnly).toEqual([
      ['9', 'Smoked salmon toast'],
      ['38', 'Beef stroganoff'],
      ['55', 'Hotdog'],
    ]);
    expect(MENU_LINES.filter((l) => l.numbers.central === undefined)).toEqual([]);
  });

  it('prices every line in whole baht, or marks it unpriced', () => {
    for (const l of MENU_LINES) {
      for (const baht of [l.baht, l.glassBaht, l.bottleBaht]) {
        if (baht === undefined || baht === null) continue;
        expect(Number.isInteger(baht) && baht >= 0).toBe(true);
      }
      const priced = l.baht !== null || l.bottleBaht !== undefined || l.glassBaht !== undefined;
      if (!priced) expect(l.name).toBe('Selection of cakes');
    }
  });

  it('prints the price list sections in full', () => {
    const counted: Record<string, number> = {};
    for (const l of SHOP_LINES) counted[l.category] = (counted[l.category] ?? 0) + 1;
    expect(counted).toEqual({ 'CAT-BALLOONS': 5, 'CAT-MERCHANDISE': 19, 'CAT-WORKSHOP': 4 });
    expect(PRINTED_SHOP_COUNTS).toEqual(counted);
    expect(SPECIAL_LINES.map((x) => [x.name, x.baht])).toEqual([
      ['Sea Salt & Maple Latte', 170],
      ['OTO Buffalo Wings', 240],
    ]);
    expect(FREE_DRINK_LINES).toHaveLength(13);
  });
});

describe('the categories', () => {
  it('are one valid top-level tab per printed section, each with a unique code', () => {
    const codes = REAL_CATEGORIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(27);
    for (const c of REAL_CATEGORIES) {
      expect(() => CodeSchema.parse(c.code)).not.toThrow();
      expect(() =>
        MenuCategoryBodySchema.parse({ code: c.code, name: c.name, taxableCategory: c.taxable, defaultPrepStation: c.prep, sortOrder: c.sort }),
      ).not.toThrow();
    }
  });

  it('route food to the kitchen, drinks to the bar and the shop nowhere', () => {
    const byCode = new Map(REAL_CATEGORIES.map((c) => [c.code, c]));
    for (const code of ['CAT-BREAKFAST', 'CAT-PIZZA', 'CAT-KIDS', 'CAT-DESSERTS']) {
      expect(byCode.get(code)).toMatchObject({ taxable: 'fnb', prep: 'kitchen' });
    }
    for (const code of ['CAT-COFFEE', 'CAT-TEA-POT', 'CAT-KIDS-JUICE', 'CAT-FREE-DRINKS']) {
      expect(byCode.get(code)).toMatchObject({ taxable: 'fnb', prep: 'bar' });
    }
    for (const code of ['CAT-WINE', 'CAT-BEER']) expect(byCode.get(code)).toMatchObject({ taxable: 'bar', prep: 'bar' });
    for (const code of ['CAT-BALLOONS', 'CAT-MERCHANDISE', 'CAT-WORKSHOP']) {
      expect(byCode.get(code)).toMatchObject({ taxable: 'merch', prep: 'none' });
    }
  });
});

describe('a park catalogue', () => {
  const central = buildParkCatalog('central');
  const chalong = buildParkCatalog('chalong');
  const categoryCodes = new Set(REAL_CATEGORIES.map((c) => c.code));

  it.each([
    ['central', central, 121],
    ['chalong', chalong, 118],
  ] as const)('%s: one product per priced line, wine twice, plus 2 specials, 28 shop items and Chinese Tea', (_park, catalog, menu) => {
    expect(catalog.products.filter((p) => p.source === 'menu')).toHaveLength(menu);
    expect(catalog.products.filter((p) => p.source === 'special')).toHaveLength(2);
    expect(catalog.products.filter((p) => p.source === 'shop')).toHaveLength(28);
    expect(catalog.products.filter((p) => p.source === 'current-pos')).toHaveLength(1);
    expect(catalog.products.filter((p) => p.source === 'free-drink')).toHaveLength(0);
  });

  it('gives every product a unique valid code, a known category and a whole non-negative satang price', () => {
    const all = [...central.products, ...chalong.products];
    const codes = all.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    // Every product has a tab; Chinese Tea sits under Tea pot by placement.
    expect(all.filter((p) => p.categoryCode === null).map((p) => p.code)).toEqual([]);
    for (const p of all) {
      expect(() => CodeSchema.parse(p.code)).not.toThrow();
      if (p.categoryCode !== null) expect(categoryCodes.has(p.categoryCode)).toBe(true);
      expect(Number.isInteger(p.priceSatang) && p.priceSatang >= 0).toBe(true);
      expect(p.priceWeekendSatang).toBeNull();
      // What the Console's item form would accept, so the rows round-trip through it.
      expect(() =>
        MenuItemBodySchema.parse({ kind: p.kind, code: p.code, name: p.name, description: p.description, priceSatang: p.priceSatang }),
      ).not.toThrow();
      for (const g of p.groups) {
        expect(new Set(g.options.map((o) => o.name)).size).toBe(g.options.length);
        for (const o of g.options) expect(Number.isInteger(o.priceSatang) && o.priceSatang >= 0).toBe(true);
      }
      expect(p.code.startsWith(central.products.includes(p) ? 'CF-' : 'RC-')).toBe(true);
    }
  });

  it('keeps each park its own printed number', () => {
    const at = (catalog: typeof central, code: string) => catalog.products.find((p) => p.code === code);
    expect(at(central, 'CF-24')).toMatchObject({ name: 'Margherita', priceSatang: 40000, kind: 'menu', categoryCode: 'CAT-PIZZA' });
    expect(at(chalong, 'RC-23')).toMatchObject({ name: 'Margherita', priceSatang: 40000 });
    expect(at(central, 'CF-15-1')).toMatchObject({ name: 'Caesar salad — With chicken', priceSatang: 41500 });
    expect(at(central, 'CF-10-10')).toMatchObject({ name: 'Grilled shrimp', priceSatang: 9500 });
    expect(at(chalong, 'RC-9-10')).toMatchObject({ name: 'Grilled shrimp', priceSatang: 9500 });
    expect(at(central, 'CF-64-5')).toMatchObject({ name: 'Camomile', priceSatang: 11500 });
    expect(at(chalong, 'RC-58-1')).toMatchObject({ name: 'Honey lemon', priceSatang: 13500 });
    expect(at(central, 'CF-9')).toMatchObject({ name: 'Smoked salmon toast' });
    expect(at(chalong, 'RC-9')).toBeUndefined();
  });

  it('sells wine by the glass and the bottle, and red by the bottle only', () => {
    const wine = central.products.filter((p) => p.categoryCode === 'CAT-WINE').map((p) => [p.code, p.priceSatang]);
    expect(wine).toEqual([
      ['CF-67-GLASS', 35000],
      ['CF-67-BOTTLE', 135000],
      ['CF-68-GLASS', 35000],
      ['CF-68-BOTTLE', 155000],
      ['CF-69-GLASS', 35000],
      ['CF-69-BOTTLE', 155000],
      ['CF-70-BOTTLE', 165000],
    ]);
  });

  it('turns slash lists into a required +0 choice and "Add on" lines into an optional +50', () => {
    const krapao = central.products.find((p) => p.code === 'CF-41')!;
    expect(krapao.groups).toEqual([
      {
        name: 'Protein',
        required: true,
        selectionType: 'single',
        options: [
          { name: 'Vegetarian', priceSatang: 0 },
          { name: 'chicken', priceSatang: 0 },
          { name: 'shrimp', priceSatang: 0 },
        ],
      },
      { name: 'Add on', required: false, selectionType: 'single', options: [{ name: 'Fried egg', priceSatang: 5000 }] },
    ]);
    expect(krapao.description).toBe('Thai basil stir-fry, garlic, chili, jasmine rice [dairy-free, gluten-free]');
    expect(central.products.find((p) => p.code === 'CF-42')!.groups.map((g) => g.name)).toEqual(['Protein']);
    expect(chalong.products.find((p) => p.code === 'RC-3')!.groups[0]!.options).toEqual([{ name: 'Egg your way', priceSatang: 5000 }]);
  });

  it('writes each park its own printed description', () => {
    expect(central.products.find((p) => p.code === 'CF-4')!.description).toBe('Banana, blueberry , choice of sauce [vegetarian]');
    expect(chalong.products.find((p) => p.code === 'RC-4')!.description).toBe('Banana, blueberry, choice of sauce [vegetarian]');
    expect(central.products.find((p) => p.code === 'CF-22')!.description).toBe(
      'aglio e olio peperoncino — Garlic, chili, olives, cherry tomato, parmesan [vegetarian]',
    );
    expect(central.products.find((p) => p.code === 'CF-63-1')!.description).toBe('300ml');
    expect(central.products.find((p) => p.code === 'CF-10-1')!.description).toBeNull();
  });

  it('routes the latte special to the bar and keeps the shop as merch', () => {
    expect(central.products.find((p) => p.code === 'CF-SPECIAL-01')).toMatchObject({ prepStationOverride: 'bar', active: true, priceSatang: 17000 });
    expect(central.products.find((p) => p.code === 'CF-SPECIAL-02')).toMatchObject({ prepStationOverride: null, priceSatang: 24000 });
    expect(central.products.filter((p) => p.source === 'shop').every((p) => p.kind === 'merch')).toBe(true);
    expect(central.products.find((p) => p.code === 'CF-MERCH-06')).toMatchObject({ name: 'Merch Frozen Kids Backpack', priceSatang: 150000 });
  });

  it.each([
    ['central', central, 'CF-CHINESE-TEA'],
    ['chalong', chalong, 'RC-CHINESE-TEA'],
  ] as const)('%s: sells Chinese Tea at the owner\'s 140 THB with the current POS\'s required "Tea Choice"', (_park, catalog, code) => {
    const tea = catalog.products.filter((p) => /chinese tea/i.test(p.name));
    expect(tea).toHaveLength(1);
    expect(tea[0]).toEqual({
      code,
      name: 'Chinese Tea',
      description: null,
      categoryCode: 'CAT-TEA-POT',
      kind: 'menu',
      priceSatang: 14000,
      priceWeekendSatang: null,
      prepStationOverride: null,
      active: true,
      // Last, so adding it moved no other row.
      sortOrder: Math.max(...catalog.products.map((p) => p.sortOrder)),
      groups: [
        {
          name: 'Tea Choice',
          required: true,
          selectionType: 'single',
          options: ['Rose black', 'Osmanthus oolong', 'Jasmine grape green', 'Peach oolong', 'Lychee black'].map((name) => ({
            name,
            priceSatang: 0,
          })),
        },
      ],
      source: 'current-pos',
    });
    expect(catalog.notSeeded.some((n) => n.name === 'Chinese Tea')).toBe(false);
  });

  it('leaves out the unpriced cakes and, until the owner answers, the free drinks', () => {
    expect(central.products.find((p) => p.code === 'CF-57')).toBeUndefined();
    expect(central.notSeeded.find((n) => n.code === 'CF-57')?.reason).toMatch(/no price/);
    for (const catalog of [central, chalong]) {
      const free = catalog.notSeeded.filter((n) => n.code?.includes('-FREE-'));
      expect(free).toHaveLength(13);
      // The owner asked for them "seeded hidden"; the reason names why that is not hidden today.
      for (const n of free) expect(n.reason).toMatch(/seeded hidden.*F&B grid shows inactive/);
      expect(catalog.products.some((p) => p.source === 'free-drink')).toBe(false);
    }
  });

  it('writes the free drinks at 0 THB and inactive when asked, without moving anything else', () => {
    const withFree = buildParkCatalog('central', { includeFreeDrinks: true });
    const free = withFree.products.filter((p) => p.source === 'free-drink');
    expect(free).toHaveLength(13);
    expect(free.every((p) => p.priceSatang === 0 && p.active === false && p.categoryCode === 'CAT-FREE-DRINKS')).toBe(true);
    expect(free[0]).toMatchObject({ code: 'CF-FREE-58-1', name: 'Espresso' });
    const order = new Map(withFree.products.map((p) => [p.code, p.sortOrder]));
    for (const p of central.products) expect(order.get(p.code)).toBe(p.sortOrder);
  });
});
