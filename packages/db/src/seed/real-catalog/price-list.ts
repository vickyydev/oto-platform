/**
 * The shop, the November specials, the Free Drinks Menu, and Chinese Tea.
 *
 * Sources, transcribed 2026-11-09: `OTO_PLAY_PARK_POS_Price_List.pdf` (3 pages, "All
 * prices in THB, including 7% VAT"; it names no branch) for 04 Balloons, 05
 * Merchandise and 06 Workshop; the two "NOVEMBER'S SPECIAL" table cards
 * (`photo-november-special-*.jpg`); the "Free Drinks Menu" card
 * (`photo-free-drinks-menu.jpg`, no prices printed). Generated once from that
 * transcription; edit it by hand from here on (README.md). Chinese Tea was added
 * by hand from the owner's answers of 9 November 2026 (`CURRENT_POS_LINES`).
 *
 * The price list prints no item numbers, so a shop item's key is its section and
 * its position in that printed section (BALLOON-01 is the first balloon line).
 * Names are copied as printed ("Merch ..." included).
 */
import type { CurrentPosLine, FreeDrinkLine, ShopLine, SpecialLine } from './types';

export const SHOP_LINES: readonly ShopLine[] = [
  // --- 04 Balloons ------------------------------------------------------------
  { category: 'CAT-BALLOONS', key: 'BALLOON-01', name: 'Helium Balloon (65)', baht: 65 },
  { category: 'CAT-BALLOONS', key: 'BALLOON-02', name: 'Helium Balloon (75)', baht: 75 },
  { category: 'CAT-BALLOONS', key: 'BALLOON-03', name: 'Helium Foil Balloon S', baht: 150 },
  { category: 'CAT-BALLOONS', key: 'BALLOON-04', name: 'Helium Foil Balloon M', baht: 200 },
  { category: 'CAT-BALLOONS', key: 'BALLOON-05', name: 'Helium Foil Balloon L', baht: 250 },
  // --- 05 Merchandise ------------------------------------------------------------
  { category: 'CAT-MERCHANDISE', key: 'MERCH-01', name: 'Merch Little OTO', baht: 490 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-02', name: 'Merch Potato Head Toy', baht: 700 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-03', name: 'Merch Glasses Necklace', baht: 650 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-04', name: 'Merch Kids Beaded Necklace', baht: 200 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-05', name: 'Merch Frozen Bracelet Set', baht: 150 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-06', name: 'Merch Frozen Kids Backpack', baht: 1500 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-07', name: 'Merch Princess Jewelry Set', baht: 300 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-08', name: 'Merch Round Sunglasses', baht: 800 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-09', name: 'Merch Wooden Twist Animal', baht: 200 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-10', name: 'Merch Peppa Pig Figures', baht: 150 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-11', name: 'Merch Blue Emoji Toy', baht: 100 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-12', name: 'Merch Small Bunny', baht: 390 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-13', name: 'Merch Middle Bunny', baht: 690 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-14', name: 'Merch Big Bunny', baht: 1290 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-15', name: 'Merch Rainbow Kids Backpack', baht: 1500 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-16', name: 'Merch Duggee Dance Toy', baht: 690 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-17', name: 'Merch Deer Kids Backpack', baht: 1050 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-18', name: 'Merch Dino Monster Truck', baht: 1200 },
  { category: 'CAT-MERCHANDISE', key: 'MERCH-19', name: 'Merch Frozen Hair Brush', baht: 200 },
  // --- 06 Workshop ------------------------------------------------------------
  { category: 'CAT-WORKSHOP', key: 'WORKSHOP-01', name: 'OTO CS Necklace', baht: 150 },
  { category: 'CAT-WORKSHOP', key: 'WORKSHOP-02', name: 'OTO CS Mirror & Pen', baht: 250 },
  { category: 'CAT-WORKSHOP', key: 'WORKSHOP-03', name: 'OTO CS Keychain', baht: 200 },
  { category: 'CAT-WORKSHOP', key: 'WORKSHOP-04', name: 'OTO CS Bracelet', baht: 100 },
];

/** Printed lines per shop section on the price list. */
export const PRINTED_SHOP_COUNTS = { 'CAT-BALLOONS': 5, 'CAT-MERCHANDISE': 19, 'CAT-WORKSHOP': 4 } as const;

/**
 * The two November specials. The cards print a name and a price only: no year,
 * no dates, no branch. The latte card does not say hot or iced.
 */
export const SPECIAL_LINES: readonly SpecialLine[] = [
  { key: 'SPECIAL-01', name: 'Sea Salt & Maple Latte', baht: 170, servedAs: 'drink', prep: 'bar', month: 'November' },
  { key: 'SPECIAL-02', name: 'OTO Buffalo Wings', baht: 240, servedAs: 'food', prep: 'kitchen', month: 'November' },
];

/**
 * Items on the park's current POS that no printed document lists. Chinese Tea:
 * the name and its required single choice "Tea Choice" with five options at
 * THB0.00 are as the current POS shows them
 * (`photo-current-pos-chinese-tea-variants.jpg`); the 140 THB is the owner's
 * written answer of 9 November 2026 (`owner-answers-2026-11-09.md`: "chinese
 * tea and its types prices are 140"), for both parks. Neither names its tab; it
 * sits under Tea pot, the printed menu's tea section, so the till can show it
 * and it prints at the bar like the other teas (a placement, not a price: the
 * owner can move it).
 */
export const CURRENT_POS_LINES: readonly CurrentPosLine[] = [
  {
    key: 'CHINESE-TEA',
    name: 'Chinese Tea',
    baht: 140,
    category: 'CAT-TEA-POT',
    choices: [
      {
        name: 'Tea Choice',
        options: ['Rose black', 'Osmanthus oolong', 'Jasmine grape green', 'Peach oolong', 'Lychee black'],
      },
    ],
  },
];

/**
 * The "Free Drinks Menu" card, line by line. Its numbers are the card's own
 * (they match the Central Floresta menu's Coffee, Iced Coffee, Chocolate and Soda
 * lines). The card prints no price and no rule for who may have a drink.
 */
export const FREE_DRINK_LINES: readonly FreeDrinkLine[] = [
  { number: '58.1', cardSection: 'Coffee', name: 'Espresso' },
  { number: '58.2', cardSection: 'Coffee', name: 'Americano' },
  { number: '58.3', cardSection: 'Coffee', name: 'Cappuccino' },
  { number: '58.4', cardSection: 'Coffee', name: 'Latte' },
  { number: '58.5', cardSection: 'Coffee', name: 'Mocha' },
  { number: '59.1', cardSection: 'Iced Coffee', name: 'Iced Americano' },
  { number: '59.2', cardSection: 'Iced Coffee', name: 'Iced Latte' },
  { number: '59.3', cardSection: 'Iced Coffee', name: 'Iced Cappuccino' },
  { number: '59.4', cardSection: 'Iced Coffee', name: 'Iced Mocha' },
  { number: '60.1', cardSection: 'Chocolate', name: 'Hot Chocolate' },
  { number: '60.2', cardSection: 'Chocolate', name: 'Iced Chocolate' },
  { number: '61.1', cardSection: 'Soda', name: 'Honey Lemon Soda' },
  { number: '61.2', cardSection: 'Soda', name: 'Ginger Lime Soda' },
];
