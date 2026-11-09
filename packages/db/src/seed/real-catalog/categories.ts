/**
 * The real catalogue's categories (2026-11-09): one top-level tab per printed
 * section of the two park menus (`Menu_eng_CENTRAL.pdf`,
 * `Menu_eng_ROBINSON_chalong.pdf`), the November specials, the Free Drinks Menu
 * card, and the price list's 04 Balloons, 05 Merchandise and 06 Workshop
 * (`OTO_PLAY_PARK_POS_Price_List.pdf`).
 *
 * Categories are operator-wide (`product_category` has no branch), so both parks
 * share this one tree; the till shows a tab at a park only when that park has
 * items in it. Every row is top-level, so each carries its own taxable area and
 * prep station, set the way `seed/menu.ts` sets its own: food to the kitchen
 * under `fnb`, drinks to the bar under `fnb`, wine and beer to the bar under
 * `bar`, the shop to no station under `merch`.
 *
 * Sort orders start at 10 so the demo tabs (sort 0-7, `seed/menu.ts`) never
 * interleave with these while both are live at a park. The order is the
 * sections' printed order; the two menus differ only in Soup and Salads, which
 * Robinson Chalong prints the other way round, and this list follows the order
 * the catalogue task names (Soup before Salads).
 */
import type { RealCategory } from './types';

type Row = Omit<RealCategory, 'sort'>;

const FOOD = { taxable: 'fnb', prep: 'kitchen' } as const;
const DRINK = { taxable: 'fnb', prep: 'bar' } as const;
const ALCOHOL = { taxable: 'bar', prep: 'bar' } as const;
const SHOP = { taxable: 'merch', prep: 'none' } as const;

const ROWS: Row[] = [
  { code: 'CAT-BREAKFAST', name: 'Breakfast', ...FOOD },
  { code: 'CAT-SIDES', name: 'Sides', ...FOOD },
  { code: 'CAT-SHARING', name: 'Sharing', ...FOOD },
  { code: 'CAT-SOUP', name: 'Soup', ...FOOD },
  { code: 'CAT-SALADS', name: 'Salads', ...FOOD },
  { code: 'CAT-PASTA', name: 'Pasta', ...FOOD },
  { code: 'CAT-PIZZA', name: 'Pizza', ...FOOD },
  { code: 'CAT-MAINS', name: 'Mains', ...FOOD },
  { code: 'CAT-ASIAN-FOOD', name: 'Asian Food', ...FOOD },
  { code: 'CAT-KIDS', name: 'Kids', ...FOOD },
  { code: 'CAT-DESSERTS', name: 'Desserts', ...FOOD },
  { code: 'CAT-COFFEE', name: 'Coffee', ...DRINK },
  { code: 'CAT-ICED-COFFEE', name: 'Iced Coffee', ...DRINK },
  { code: 'CAT-CHOCOLATE', name: 'Chocolate', ...DRINK },
  { code: 'CAT-SODA', name: 'Soda', ...DRINK },
  { code: 'CAT-SMOOTHIES', name: 'Smoothies', ...DRINK },
  { code: 'CAT-JUICE', name: 'Juice', ...DRINK },
  { code: 'CAT-TEA-POT', name: 'Tea pot', ...DRINK },
  { code: 'CAT-SOFT-DRINKS', name: 'Soft drinks', ...DRINK },
  { code: 'CAT-KIDS-JUICE', name: 'Kids juice', ...DRINK },
  { code: 'CAT-WINE', name: 'Wine', ...ALCOHOL },
  { code: 'CAT-BEER', name: 'Beer', ...ALCOHOL },
  // The latte on it is routed to the bar by its own prep override.
  { code: 'CAT-SPECIALS', name: 'Specials', ...FOOD },
  { code: 'CAT-FREE-DRINKS', name: 'Free Drinks Menu', ...DRINK },
  { code: 'CAT-BALLOONS', name: 'Balloons', ...SHOP },
  { code: 'CAT-MERCHANDISE', name: 'Merchandise', ...SHOP },
  { code: 'CAT-WORKSHOP', name: 'Workshop', ...SHOP },
];

export const REAL_CATEGORIES: readonly RealCategory[] = ROWS.map((row, index) => ({
  ...row,
  sort: 10 + index,
}));
