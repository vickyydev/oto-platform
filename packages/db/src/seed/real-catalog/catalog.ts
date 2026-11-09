/**
 * From the printed documents to the rows one park's till sells (2026-11-09).
 *
 * Pure: no database. `buildParkCatalog('central')` is every product Central
 * Floresta's till gets, in the order the documents print them, plus the list of
 * printed lines it deliberately leaves out and why. The loader in `index.ts`
 * converges a branch on exactly this list.
 *
 * The rules, each one the catalogue task's:
 *   - Every numbered printed line is its own product, its code the park's prefix
 *     and the printed number with dots made hyphens (`CodeSchema` allows no dot):
 *     Central's "15.1 With chicken" is CF-15-1.
 *   - A section price printed once is each of its lines' price (already so in
 *     the data).
 *   - A wine line is two products, glass and bottle, because a size
 *     (`ProductVariant`) carries no price of its own: CF-67-GLASS, CF-67-BOTTLE.
 *   - A printed slash list is a required single choice, every option +0; a
 *     printed "Add on ..." line is an optional group with its one priced option.
 *   - The menus have no field for the diet icons, so they go into the
 *     description in brackets: "[vegetarian, dairy-free]".
 *   - One price whatever the day: the weekend price is null throughout.
 *   - No translations: no document prints one.
 *   - Chinese Tea, on the current POS and in no document, carries the owner's
 *     price (owner-answers-2026-11-09.md) and its "Tea Choice" as the current
 *     POS shows it, at both parks, with no category until the owner names its
 *     tab: CF-CHINESE-TEA, RC-CHINESE-TEA.
 */
import { satangFromBaht } from '@oto/shared';
import { REAL_CATEGORIES } from './categories';
import { MENU_LINES } from './menu-lines';
import { CURRENT_POS_LINES, FREE_DRINK_LINES, SHOP_LINES, SPECIAL_LINES } from './price-list';
import {
  PARK_CODE_PREFIX,
  type GroupSeed,
  type MenuLine,
  type NotSeeded,
  type Park,
  type ProductSeed,
} from './types';

/** "15.1" at Central -> "CF-15-1". */
export function productCode(park: Park, printed: string, suffix?: string): string {
  const base = `${PARK_CODE_PREFIX[park]}-${printed.replace(/\./g, '-')}`;
  return suffix ? `${base}-${suffix}` : base;
}

/**
 * The description a line's product carries at one park: its printed subtitle,
 * wine sub-heading, ingredient line and serving size, then the diet icons in
 * brackets. Null when the menu prints none of them.
 */
export function lineDescription(line: MenuLine, park: Park): string | null {
  const parts = [
    line.subtitle?.replace(/^\/+|\/+$/g, '').trim(),
    line.subsection,
    line.descriptionByPark?.[park] ?? line.description,
    line.servingNote,
  ].filter((p): p is string => !!p && p.length > 0);
  const diet = line.diet?.length ? `[${line.diet.join(', ')}]` : '';
  const text = [parts.join(' — '), diet].filter((p) => p.length > 0).join(' ');
  return text.length > 0 ? text : null;
}

/** An indented sub-line reads on its own at the till: "Caesar salad — With chicken". */
export function lineName(line: MenuLine): string {
  return line.parentName ? `${line.parentName} — ${line.name}` : line.name;
}

/** The printed slash lists and "Add on" lines of a menu line, as inline groups. */
export function lineGroups(line: MenuLine): GroupSeed[] {
  const groups: GroupSeed[] = (line.choices ?? []).map((c) => ({
    name: c.name,
    required: true,
    selectionType: 'single',
    options: c.options.map((name) => ({ name, priceSatang: 0 })),
  }));
  if (line.addOns?.length) {
    groups.push({
      // "Add on" is the printed wording ("Add on fried egg is optional — 50 THB").
      name: 'Add on',
      required: false,
      selectionType: 'single',
      options: line.addOns.map((a) => ({ name: a.name, priceSatang: satangFromBaht(a.baht) })),
    });
  }
  return groups;
}

const categoryPrep = new Map(REAL_CATEGORIES.map((c) => [c.code, c.prep]));

export interface ParkCatalog {
  park: Park;
  products: ProductSeed[];
  notSeeded: NotSeeded[];
}

export interface BuildOptions {
  /**
   * Write the Free Drinks Menu card's drinks too. Off by default. The owner's
   * answer of 9 November 2026 is that the card "stays seeded hidden (active:
   * false)", but on today's till `active: false` does not hide a menu item: the
   * F&B grid does not read `active` (`apps/pos/src/api/menu.ts` mapMenu, and
   * `MenuItem` has no such field), so the 13 drinks would show at 0 THB while
   * the sale refuses them (`services/sale.ts` loads active products only). That
   * consequence is a question to the owner (README.md); until it is answered
   * they stay out.
   */
  includeFreeDrinks?: boolean;
}

export function buildParkCatalog(park: Park, opts: BuildOptions = {}): ParkCatalog {
  const products: Omit<ProductSeed, 'sortOrder'>[] = [];
  const notSeeded: NotSeeded[] = [];

  for (const line of MENU_LINES) {
    const number = line.numbers[park];
    if (number === undefined) continue;
    const base = {
      description: lineDescription(line, park),
      categoryCode: line.category,
      kind: 'menu' as const,
      priceWeekendSatang: null,
      prepStationOverride: null,
      active: true,
      groups: lineGroups(line),
      source: 'menu' as const,
    };
    if (line.glassBaht !== undefined || line.bottleBaht !== undefined) {
      if (line.glassBaht !== undefined) {
        products.push({
          ...base,
          code: productCode(park, number, 'GLASS'),
          name: `${lineName(line)} (glass)`,
          priceSatang: satangFromBaht(line.glassBaht),
        });
      }
      if (line.bottleBaht !== undefined) {
        products.push({
          ...base,
          code: productCode(park, number, 'BOTTLE'),
          name: `${lineName(line)} (bottle)`,
          priceSatang: satangFromBaht(line.bottleBaht),
        });
      }
      continue;
    }
    if (line.baht === null) {
      notSeeded.push({
        park,
        name: line.name,
        code: productCode(park, number),
        reason: 'no price is printed on the menu',
      });
      continue;
    }
    products.push({
      ...base,
      code: productCode(park, number),
      name: lineName(line),
      priceSatang: satangFromBaht(line.baht),
    });
  }

  for (const special of SPECIAL_LINES) {
    products.push({
      code: `${PARK_CODE_PREFIX[park]}-${special.key}`,
      name: special.name,
      description: null,
      categoryCode: 'CAT-SPECIALS',
      kind: 'menu',
      priceSatang: satangFromBaht(special.baht),
      priceWeekendSatang: null,
      prepStationOverride: special.prep === categoryPrep.get('CAT-SPECIALS') ? null : special.prep,
      active: true,
      groups: [],
      source: 'special',
    });
  }

  for (const drink of FREE_DRINK_LINES) {
    const code = `${PARK_CODE_PREFIX[park]}-FREE-${drink.number.replace(/\./g, '-')}`;
    if (!opts.includeFreeDrinks) {
      notSeeded.push({
        park,
        name: drink.name,
        code,
        reason:
          'Free Drinks Menu: the owner asked for it seeded hidden (active: false), but the F&B grid shows inactive menu items, so withheld until the owner answers; --include-free-drinks writes it',
      });
    }
    // Built either way so every other row's sort order is the same with or
    // without the free drinks; dropped below when they are not wanted.
    products.push({
      code,
      name: drink.name,
      description: null,
      categoryCode: 'CAT-FREE-DRINKS',
      kind: 'menu',
      priceSatang: 0,
      priceWeekendSatang: null,
      prepStationOverride: null,
      active: false,
      groups: [],
      source: 'free-drink',
    });
  }

  for (const item of SHOP_LINES) {
    products.push({
      code: `${PARK_CODE_PREFIX[park]}-${item.key}`,
      name: item.name,
      description: null,
      categoryCode: item.category,
      kind: 'merch',
      priceSatang: satangFromBaht(item.baht),
      priceWeekendSatang: null,
      prepStationOverride: null,
      active: true,
      groups: [],
      source: 'shop',
    });
  }

  // Last, so adding it moved no other row's sort order.
  for (const item of CURRENT_POS_LINES) {
    products.push({
      code: `${PARK_CODE_PREFIX[park]}-${item.key}`,
      name: item.name,
      description: null,
      categoryCode: item.category,
      kind: 'menu',
      priceSatang: satangFromBaht(item.baht),
      priceWeekendSatang: null,
      prepStationOverride: null,
      active: true,
      groups: item.choices.map((c) => ({
        name: c.name,
        required: true,
        selectionType: 'single',
        options: c.options.map((name) => ({ name, priceSatang: 0 })),
      })),
      source: 'current-pos',
    });
  }

  notSeeded.push({
    park,
    name: 'Price list 01 Tickets, 02 Expat Entry, 03 Extras',
    reason:
      'ticket packages, adult rules, drop-off and nanny pricing are not catalogue products; this loader never writes them',
  });

  const ordered = products.map((p, sortOrder) => ({ ...p, sortOrder }));
  return {
    park,
    products: opts.includeFreeDrinks ? ordered : ordered.filter((p) => p.source !== 'free-drink'),
    notSeeded,
  };
}
