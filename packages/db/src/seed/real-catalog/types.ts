/**
 * The shapes the park's real till catalogue is written in (2026-11-09).
 *
 * The data files (`menu-lines.ts`, `price-list.ts`) hold what the documents
 * print, in the documents' own words; `catalog.ts` turns them into the rows a
 * park's till sells. Nothing in these shapes carries a value no document
 * prints: where a document is silent the field is absent and the item is
 * either not seeded or the gap is a question in README.md.
 */
import type { PrepStation, TaxableCategory } from '../../schema/catalog';

/** The two parks. Each has its own printed menu and its own numbering. */
export const PARKS = ['central', 'chalong'] as const;
export type Park = (typeof PARKS)[number];

/**
 * The prefix every product code of a park carries. Product codes are unique per
 * OPERATOR (`product_code_unique`), and the two menus number the same dish
 * differently, so the park is part of the code: CF-24 is Central Floresta's
 * "24. Margherita", RC-23 is Robinson Chalong's "23. Margherita".
 */
export const PARK_CODE_PREFIX: Record<Park, string> = { central: 'CF', chalong: 'RC' };

/** How each park is found: `core.branch.code` (seed/index.ts CENTRAL_CODE, CHALONG_CODE). */
export const PARK_BRANCH_CODE: Record<Park, string> = {
  central: 'hkt-central',
  chalong: 'robinson-chalong',
};

/** The three icons the menus print beside a title: leaf, drop, yellow dot. */
export type Diet = 'vegetarian' | 'dairy-free' | 'gluten-free';

export interface RealCategory {
  /** Operator-wide stable key (`product_category.code`). */
  code: string;
  /** The printed section heading. */
  name: string;
  /** Which taxable area the till files its money under. */
  taxable: TaxableCategory;
  /** Where its prep ticket prints: food to the kitchen, drinks to the bar, shop nowhere. */
  prep: PrepStation;
  sort: number;
}

/** A printed slash list under an item: a required single choice, every option +0. */
export interface PrintedChoice {
  /** Not printed: "Protein" or the placeholder "Choice" (a question in README.md). */
  name: string;
  /** The slash text exactly as printed. */
  printed: string;
  options: string[];
}

/** A printed "Add on ..." line: an optional extra with one priced option. */
export interface PrintedAddOn {
  /** The option's name: "Fried egg", "Egg your way". */
  name: string;
  baht: number;
  /** The line exactly as printed. */
  printed: string;
}

/** One numbered line of the printed menus, shared by both parks. */
export interface MenuLine {
  category: string;
  /** The line's name as printed. */
  name: string;
  /** For an indented sub-line (15.1 under 15): the printed name of its parent line. */
  parentName?: string;
  /** The line's printed number on each park's menu. A park absent here does not print it. */
  numbers: Partial<Record<Park, string>>;
  /** The line's printed price, or its section's. Null = none printed (wine: see glass/bottle). */
  baht: number | null;
  /** Wine only: the GLASS column. Absent = no glass price printed. */
  glassBaht?: number;
  /** Wine only: the BOTTLE column. */
  bottleBaht?: number;
  /** A printed line under the name, e.g. "/aglio e olio peperoncino/". */
  subtitle?: string;
  /** Wine only: the printed sub-heading (Bubbles, Rose wine, White wine, Red wine). */
  subsection?: string;
  /** The printed ingredient line, when both parks print the same text. */
  description?: string;
  /** The printed ingredient line per park, when the two parks print different text. */
  descriptionByPark?: Partial<Record<Park, string>>;
  /** The section's printed serving size ("/300ml/" under Juice), carried onto each line. */
  servingNote?: string;
  diet?: Diet[];
  choices?: PrintedChoice[];
  addOns?: PrintedAddOn[];
}

/** One line of the price list's Balloons, Merchandise or Workshop section. */
export interface ShopLine {
  category: string;
  /** Section and printed position, e.g. BALLOON-01. Part of the product code. */
  key: string;
  name: string;
  baht: number;
}

/** One of the "NOVEMBER'S SPECIAL" cards. */
export interface SpecialLine {
  key: string;
  name: string;
  baht: number;
  servedAs: 'drink' | 'food';
  /** A drink goes to the bar, the food to the kitchen (the Specials tab holds both). */
  prep: PrepStation;
  month: string;
}

/**
 * An item the park's current POS sells that no printed document lists, priced
 * by the owner's written answer (`owner-answers-2026-11-09.md`).
 */
export interface CurrentPosLine {
  /** Part of the product code (the item has no printed number). */
  key: string;
  /** The name as the current POS shows it. */
  name: string;
  /** The owner's price. */
  baht: number;
  /**
   * The tab it goes in. Null = no document or answer names one: the row is
   * written without a category, and the tab is a question in README.md.
   */
  category: string | null;
  /** The current POS's required single choices, every option +0 as it shows them. */
  choices: Array<{ name: string; options: string[] }>;
}

/** One line of the "Free Drinks Menu" card. */
export interface FreeDrinkLine {
  /** The card's own number, e.g. 58.1. */
  number: string;
  /** The card's printed section heading. */
  cardSection: string;
  name: string;
}

/** An inline modifier group as the loader writes it. */
export interface GroupSeed {
  name: string;
  required: boolean;
  selectionType: 'single';
  options: Array<{ name: string; priceSatang: number }>;
}

/** One product row as the loader writes it for one park. */
export interface ProductSeed {
  code: string;
  name: string;
  description: string | null;
  /** Null only where no source names the tab (Chinese Tea): written without a category. */
  categoryCode: string | null;
  kind: 'menu' | 'merch';
  priceSatang: number;
  /** Always null: every document prints one price, whatever the day. */
  priceWeekendSatang: null;
  prepStationOverride: PrepStation | null;
  /** Written on insert only, so a later switch in the Console is never argued with. */
  active: boolean;
  sortOrder: number;
  groups: GroupSeed[];
  /** Which part of the catalogue it comes from (the free drinks are opt-in). */
  source: 'menu' | 'special' | 'shop' | 'free-drink' | 'current-pos';
}

/** A printed line the loader deliberately does not write, and why. */
export interface NotSeeded {
  park: Park | 'both';
  name: string;
  /** The code it would carry, when it has a printed number. */
  code?: string;
  reason: string;
}
