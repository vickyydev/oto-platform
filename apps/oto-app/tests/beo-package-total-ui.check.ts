// seed: none — a pure render, no database. Not a Playwright file: it renders
// the BEO package module's own total breakdown (the component the module
// shows under its add-ons) to markup, so it runs with the JSX tsconfig.
//
// SCRUM-808 — "Package Total: ฿0.00" for a package priced by day. The
// included lines are 0-baht by design (SCRUM-803 put the price on the
// package); the total now reads the package's own price for the party's day,
// the children and adults beyond its included counts at its own extra prices,
// and the add-ons bought (shared/partyPackageTotal.ts, which Generate from
// BEO reads the same way — tests/birthday-packages.check.ts drives that over
// HTTP). Pinned here: the breakdown lines and the total a weekday and a
// weekend party with extras show, the lines a party within its counts shows,
// and an extra the package prices none for (counted, never priced).
//
// Run from apps/oto-app:
//   TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-package-total-ui.check.ts
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.APP_ENV ??= "dev";

const { PackageTotalBreakdown } = await import("../client/src/components/beo/beo-package-module");
const { partyPackageTotal } = await import("../shared/partyPackageTotal");
type Prices = import("../shared/partyPackageTotal").PartyPackagePrices;

/** The Floresta package as SCRUM-803's seed prints it, satang; the party bought the reserved table. */
const FLORESTA: Prices = {
  basePrice: 1_690_000,
  priceWeekday: 1_690_000,
  priceWeekend: 2_090_000,
  kidsIncluded: 10,
  adultsIncluded: 4,
  extraChildWeekday: 130_000,
  extraChildWeekend: 150_000,
  extraAdultWeekday: 35_000,
  extraAdultWeekend: 50_000,
  items: [
    { label: "Ice-cream cake with candles and birthday song", included: true, billable: false, qty: 1, unitPrice: 0 },
    { label: "Kids' table reserved for 3 hours", included: true, billable: false, qty: 1, unitPrice: 0 },
    { label: "Reserved table for adults, up to 10 adults", included: false, billable: true, qty: 1, unitPrice: 500_000 },
    { label: "Classic balloon decoration", included: false, billable: true, qty: 0, unitPrice: 400_000 },
    { label: "Upgrade or customize your activity program", included: false, billable: false, qty: 1, unitPrice: 100_000 },
  ],
};

/** The breakdown's rows as [label, amount], read off the markup by their test ids. */
function rowsOf(html: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const re = /data-testid="text-package-total-(\w+)"><span>([^<]*)<\/span><span>([^<]*)<\/span>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push([m[1]!, m[2]!, m[3]!]);
  return out;
}
const totalOf = (html: string) => /data-testid="text-package-total">([^<]*(?:<!-- -->[^<]*)*)<\/span>/.exec(html)?.[1]?.replace(/<!-- -->/g, "") ?? null;
const render = (eventDate: string | null, numChildren: number, numAdults: number, pkg: Prices = FLORESTA) =>
  renderToStaticMarkup(
    React.createElement(PackageTotalBreakdown, { reading: partyPackageTotal(pkg, { eventDate, numChildren, numAdults }) }),
  ).replace(/&#x27;/g, "'");

let checks = 0;
const check = (name: string, fn: () => void) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

check("a weekday party with extras: the Monday price, 2 extra children, 1 extra adult, the add-on bought", () => {
  const html = render("2099-03-16", 12, 5);
  assert.deepEqual(rowsOf(html), [
    ["package", "Package price for Monday (weekday)", "฿16,900.00"],
    ["extraChildren", "Extra children: 2 children × ฿1,300.00", "฿2,600.00"],
    ["extraAdults", "Extra adults: 1 adult × ฿350.00", "฿350.00"],
    ["addOns", "Add-ons", "฿5,000.00"],
  ]);
  assert.equal(totalOf(html), "Package Total: ฿24,850.00");
});

check("a weekend party with extras: the Saturday price, 3 extra children, 2 extra adults", () => {
  const html = render("2099-03-14", 13, 6);
  assert.deepEqual(rowsOf(html), [
    ["package", "Package price for Saturday (weekend)", "฿20,900.00"],
    ["extraChildren", "Extra children: 3 children × ฿1,500.00", "฿4,500.00"],
    ["extraAdults", "Extra adults: 2 adults × ฿500.00", "฿1,000.00"],
    ["addOns", "Add-ons", "฿5,000.00"],
  ]);
  assert.equal(totalOf(html), "Package Total: ฿31,400.00");
});

check("a Sunday is a weekend; a party within its counts and no add-on shows the package price alone, never ฿0", () => {
  const html = render("2099-03-15", 10, 4, { ...FLORESTA, items: FLORESTA.items.filter((i) => i.included) });
  assert.deepEqual(rowsOf(html), [["package", "Package price for Sunday (weekend)", "฿20,900.00"]]);
  assert.equal(totalOf(html), "Package Total: ฿20,900.00");
  assert.ok(!html.includes("฿0.00"));
});

check("an extra the package prices none for is counted and said, never priced; no date reads the weekday", () => {
  const html = render(null, 11, 4, { ...FLORESTA, extraChildWeekday: null, items: [] });
  assert.deepEqual(rowsOf(html), [
    ["package", "Package price (weekday: the party has no date yet)", "฿16,900.00"],
    ["extraChildren", "Extra children: 1 child (the package sets no extra-child price for a weekday)", "฿0.00"],
  ]);
  assert.equal(totalOf(html), "Package Total: ฿16,900.00");
});

console.log(`beo-package-total-ui.check: ${checks} checks passed`);
process.exit(checks === 4 ? 0 : 1);
