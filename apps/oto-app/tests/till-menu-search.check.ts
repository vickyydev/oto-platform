// seed: none — no database, no browser. Not a Playwright file.
//
// SCRUM-939 — the search of the till's menu inside the BEO (the picker of
// SCRUM-905, client/src/components/beo/till-menu-picker.tsx) reads what was
// typed as it stands and lists the best answer first:
//
//   - "fries" finds French fries and nothing else: letters scattered across a
//     code and a name ("CF-6 Porridge", "CF-2 Vegetarian breakfast") are no
//     match;
//   - the name first (the whole name, whole words of it, the start of a word,
//     anywhere in it: "water" is the waters before Fresh watermelon juice),
//     then the code, then the category ("pizza" lists the pizzas,
//     whose names do not say pizza), then the station;
//   - several words must each be found; nothing typed keeps the whole menu;
//   - the best answer comes first whatever its category ("chicken": Chicken
//     schnitzel before Grilled chicken, though Sides come before Mains);
//   - "Not from the till" is found by its own words only.
//
// Usage, from apps/oto-app:
//   npx tsx tests/till-menu-search.check.ts
import assert from "node:assert/strict";
import { tillMenuSearch, tillMenuSearchScore, tillMenuWordsMatch, type TillMenuItem } from "../shared/tillMenu";

let checks = 0;
const check = (title: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const item = (code: string, name: string, category: string, parentCategory: string | null, station: "kitchen" | "bar"): TillMenuItem => ({
  code, name, category, parentCategory, station, priceSatang: 10_000, priceWeekendSatang: 10_000, beoOnly: false,
});
// The menu in the till's own order, as the picker receives it.
const MENU: TillMenuItem[] = [
  item("CF-2", "Vegetarian breakfast", "Breakfast", "Food", "kitchen"),
  item("CF-6", "Porridge", "Breakfast", "Food", "kitchen"),
  item("CF-8", "Syrniki", "Breakfast", "Food", "kitchen"),
  item("CF-10-17", "Steamed jasmine rice", "Sides", "Food", "kitchen"),
  item("CF-10-2", "Grilled tomato", "Sides", "Food", "kitchen"),
  item("CF-11", "French fries", "Sides", "Food", "kitchen"),
  item("CF-24", "Margherita", "Pizza", "Food", "kitchen"),
  item("CF-30", "Sausage, brie & onion", "Pizza", "Food", "kitchen"),
  item("CF-31", "Pepperoni", "Pizza", "Food", "kitchen"),
  item("CF-63-2", "Fresh watermelon juice", "Juice", "Drinks", "bar"),
  item("CF-66-1", "Kids juice Apple", "Kids juice", "Drinks", "bar"),
  item("CF-70", "S.Pellegrino sparkling water", "Water", "Drinks", "bar"),
  item("CF-81", "Pinot Grigio, glass", "Wine", "Drinks", "bar"),
];
/** The names the picker lists for a search: `tillMenuSearch`, the one list it shows. */
const found = (search: string): string[] => tillMenuSearch(MENU, search).map((m) => m.name);

check("\"fries\" finds French fries and nothing else: scattered letters are no match", () => {
  assert.deepEqual(found("fries"), ["French fries"]);
  assert.equal(tillMenuSearchScore(MENU[1], "fries"), 0, "CF-6 Porridge holds f, r, i, e, s in order and is still no match");
  assert.deepEqual(found("pepperoni"), ["Pepperoni"], "no sparkling water, no wine");
  assert.deepEqual(found("FRIES "), ["French fries"], "case and spaces around do not matter");
});

check("the name first: the whole name, whole words of it, the start of a word, anywhere in it", () => {
  assert.equal(tillMenuSearchScore(MENU[8], "pepperoni"), 1);
  assert.equal(tillMenuSearchScore(MENU[5], "french"), 0.97, "its first word, whole");
  assert.equal(tillMenuSearchScore(MENU[5], "fries"), 0.93, "a later word, whole");
  assert.equal(tillMenuSearchScore(MENU[7], "brie"), 0.93, "a word after a comma is a word");
  assert.equal(tillMenuSearchScore(MENU[11], "pellegrino"), 0.93, "a word after a full stop is a word");
  assert.equal(tillMenuSearchScore(MENU[5], "french fr"), 0.9, "the start of the name, a word unfinished");
  assert.equal(tillMenuSearchScore(MENU[9], "water"), 0.85, "the start of a later word");
  assert.equal(tillMenuSearchScore(MENU[9], "melon"), 0.8, "inside a word");
  assert.deepEqual(found("juice"), ["Fresh watermelon juice", "Kids juice Apple"]);
  assert.deepEqual(found("gri"), ["Grilled tomato", "Pinot Grigio, glass", "S.Pellegrino sparkling water"], "the start of the name, then the start of a later word, then inside a word");
  assert.deepEqual(found("water"), ["S.Pellegrino sparkling water", "Fresh watermelon juice"], "the whole word before the start of watermelon, though the juice comes first on the menu");
});

check("then the code, then the category, then the station", () => {
  assert.deepEqual(found("cf-24"), ["Margherita"]);
  assert.deepEqual(found("CF-10"), ["Steamed jasmine rice", "Grilled tomato"], "a code's start");
  assert.deepEqual(found("pizza"), ["Margherita", "Sausage, brie & onion", "Pepperoni"], "by the category, in the menu's order, and no wine");
  assert.deepEqual(found("63"), ["Fresh watermelon juice"], "a number inside a code");
  assert.deepEqual(found("bar"), ["Fresh watermelon juice", "Kids juice Apple", "S.Pellegrino sparkling water", "Pinot Grigio, glass"], "the station by its whole name");
  assert.deepEqual(found("drinks water"), ["S.Pellegrino sparkling water", "Fresh watermelon juice"], "the category as typed, then words found across the name and the category");
});

check("several words must each be found; nothing typed keeps the whole menu", () => {
  assert.deepEqual(found("watermelon juice"), ["Fresh watermelon juice"]);
  assert.deepEqual(found("juice watermelon"), ["Fresh watermelon juice"], "in any order");
  assert.deepEqual(found("juice pizza"), [], "a word found nowhere finds nothing");
  assert.equal(found("").length, MENU.length);
  assert.equal(found("   ").length, MENU.length);
  assert.deepEqual(found("zz no such dish"), []);
});

check("the best answer first whatever its category: a name that starts with the word before one that only holds it", () => {
  // The menu's order: Sides, Salads, Mains, Kids. The picker used to keep the headings in this order.
  const chicken: TillMenuItem[] = [
    item("CF-10-11", "Grilled chicken", "Sides", "Food", "kitchen"),
    item("CF-20", "Caesar salad — With chicken", "Salads", "Food", "kitchen"),
    item("CF-37", "Chicken schnitzel", "Mains", "Food", "kitchen"),
    item("CF-38", "Honey balsamic chicken", "Mains", "Food", "kitchen"),
    item("CF-50", "Chicken soup", "Kids", "Food", "kitchen"),
  ];
  assert.deepEqual(
    tillMenuSearch(chicken, "chicken").map((m) => m.name),
    ["Chicken schnitzel", "Chicken soup", "Grilled chicken", "Caesar salad — With chicken", "Honey balsamic chicken"],
    "the two that start with it first, in the menu's order; then the rest in the menu's order",
  );
  assert.deepEqual(tillMenuSearch(chicken, "").map((m) => m.code), chicken.map((m) => m.code), "nothing typed: the menu as given");
});

check("\"Not from the till\" is found by its own words only", () => {
  const words = ["not from the till", "remove", "clear"];
  assert.equal(tillMenuWordsMatch(words, ""), true);
  assert.equal(tillMenuWordsMatch(words, "remove"), true);
  assert.equal(tillMenuWordsMatch(words, "Not From"), true);
  assert.equal(tillMenuWordsMatch(words, "fries"), false);
});

console.log(`till-menu-search.check: ${checks} checks passed`);
