// seed: none — no database, no server, no browser. Not a Playwright file.
//
// SCRUM-949 — an EXTRA line of the BEO's kitchen and bar plan shows its price
// and what the till will charge for it (shared/beoExtras.ts), as the party
// settlement charges it (apps/api/src/services/party-settlement.ts,
// `partyExtraChargesOf` and `partyMenuChargesOf`, which this lane does not
// change; the owner's decision of 12 November: "Not 0 baht, charge it
// according to the right entered price", "its price per item"):
//
//   - an EXTRA line: the price entered on it for each item, times its count;
//     with none (0 is none), the till's price for the party's day (its weekend
//     price on a Saturday or a Sunday) for a code the till sells; with
//     neither, or a code the till no longer has, not charged;
//   - a SET line: part of the package, never charged, no price box;
//   - an item made for this party (PARTY-): the till's own price on the food
//     lists, whatever the line shows; nothing on the bar plan;
//   - the adults' copy of a kids' line (same name, count and code) is charged
//     once, on the kids' line; the adults' list counts only while it is theirs;
//   - the till's menu not read: a coded line with no price is not priced here,
//     and no total is said (nothing rather than a wrong figure);
//   - the BEO PDF prints a drink's EXTRA price for each item, as the kitchen's.
//
// Run from apps/oto-app: npx tsx tests/beo-extra-price.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-949";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
// The PDF module reads the app's config, which wants a database address; nothing here connects to one.
process.env.DATABASE_URL ??= "postgres://zz-test-949@127.0.0.1:1/none";

const {
  beoExtraChargeOf,
  beoExtraHintOf,
  beoExtrasTotalOf,
  beoExtrasTotalWords,
  beoKitchenChargesOf,
  hasExtraLines,
  isWeekendDate,
} = await import("../shared/beoExtras");
const { beoPdfHtml } = await import("../server/pdf");
type BeoExtraLine = import("../shared/beoExtras").BeoExtraLine;

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

// The till's menu at the park, satang: weekday and weekend prices.
const byCode = new Map([
  ["CF-24", { priceSatang: 40_000, priceWeekendSatang: 45_000 }],
  ["CF-11", { priceSatang: 17_500, priceWeekendSatang: 17_500 }],
  ["CF-58-4", { priceSatang: 14_500, priceWeekendSatang: 15_500 }],
  ["PARTY-B73D949A", { priceSatang: 12_000, priceWeekendSatang: 12_000 }],
]);
const WEEKDAY = "2026-12-02"; // a Wednesday
const SATURDAY = "2026-12-05"; // thread A's party
const read = { till: { known: true, byCode }, partyDate: WEEKDAY };
const unread = { till: { known: false, byCode: new Map() }, partyDate: WEEKDAY };
const line = (itemName: string, over: Partial<BeoExtraLine> = {}): BeoExtraLine => ({ itemName, quantity: 1, price: 0, ...over });

await check("an EXTRA line: the entered price for each item, times its count; else the till's for its code; else not charged", () => {
  const entered = beoExtraChargeOf(line("Margherita", { quantity: 2, price: 450, productCode: "CF-24" }), "food", read);
  assert.deepEqual(entered, { kind: "charged", unitSatang: 45_000, quantity: 2, totalSatang: 90_000, from: "entered", weekend: false });
  assert.equal(beoExtraHintOf(entered), "each");
  const till = beoExtraChargeOf(line("Margherita", { quantity: 3, productCode: "CF-24" }), "food", read);
  assert.deepEqual(till, { kind: "charged", unitSatang: 40_000, quantity: 3, totalSatang: 120_000, from: "till", weekend: false });
  assert.equal(beoExtraHintOf(till), "till price 400", "an empty box on a coded line: the till's price, what will be charged");
  assert.deepEqual(beoExtraChargeOf(line("Margherita", { price: 0, productCode: "CF-24" }), "food", read).kind, "charged", "a price of 0 is no price: the till's");
  const typed = beoExtraChargeOf(line("Durian pizza"), "food", read);
  assert.deepEqual(typed, { kind: "not_charged", why: "no_price" });
  assert.equal(beoExtraHintOf(typed), "not charged", "an empty box on a line with no code: not charged");
  assert.equal(beoExtraChargeOf(line("Durian pizza", { price: 300 }), "food", read).kind, "charged", "a hand-typed line with a price is charged at it");
  assert.deepEqual(beoExtraChargeOf(line("Old soda", { productCode: "CF-77" }), "bar", read), { kind: "not_charged", why: "not_on_till" }, "a code the till no longer has");
  // A count the till cannot read is one, as the plan view reads it.
  assert.equal((beoExtraChargeOf(line("Fries", { quantity: 0, productCode: "CF-11" }), "food", read) as { quantity: number }).quantity, 1);
  // A line with no name never reaches the till.
  assert.equal(beoExtraChargeOf(line("  ", { price: 100 }), "food", read).kind, "unnamed");
});

await check("the party's day: the till's weekend price on a Saturday or a Sunday, said so", () => {
  assert.equal(isWeekendDate(SATURDAY), true);
  assert.equal(isWeekendDate("2026-12-06"), true);
  assert.equal(isWeekendDate(WEEKDAY), false);
  assert.equal(isWeekendDate(null), false);
  const weekend = beoExtraChargeOf(line("Latte", { quantity: 2, productCode: "CF-58-4" }), "bar", { ...read, partyDate: SATURDAY });
  assert.deepEqual([weekend.kind === "charged" && weekend.unitSatang, weekend.kind === "charged" && weekend.totalSatang], [15_500, 31_000]);
  assert.equal(beoExtraHintOf(weekend), "till price 155 (weekend)");
  assert.equal(beoExtraHintOf(beoExtraChargeOf(line("Latte", { price: 160, productCode: "CF-58-4" }), "bar", { ...read, partyDate: SATURDAY })), "each", "an entered price stands on a weekend too");
});

await check("a SET line is the package's; an item made for this party is charged at the till's own price on the food lists, nothing on the bar", () => {
  const set = beoExtraChargeOf(line("Margherita", { source: "set_menu", productCode: "CF-24", price: 450 }), "food", read);
  assert.deepEqual(set, { kind: "set" });
  assert.equal(beoExtraHintOf(set), null);
  const party = beoExtraChargeOf(line("ZZ TEST unicorn cake", { quantity: 2, price: 999, productCode: "PARTY-B73D949A" }), "food", read);
  assert.deepEqual(party, { kind: "charged", unitSatang: 12_000, quantity: 2, totalSatang: 24_000, from: "party_item", weekend: false });
  assert.equal(beoExtraHintOf(party), "till price 120 (made for this party)");
  assert.equal(beoExtraChargeOf(line("ZZ TEST unicorn cake", { source: "set_menu", productCode: "PARTY-B73D949A" }), "food", read).kind, "charged", "whatever its badge");
  assert.deepEqual(beoExtraChargeOf(line("ZZ TEST party juice", { productCode: "PARTY-B73D949A", price: 50 }), "bar", read), { kind: "not_charged", why: "party_item_on_bar" });
});

await check("the adults' copy of a kids' line is charged once; their list counts only while it is theirs", () => {
  const kids = [line("Margherita", { quantity: 2, productCode: "CF-24" }), line("Fries", { quantity: 3, productCode: "CF-11", price: 0 })];
  const adults = [line("Margherita", { quantity: 2, productCode: "CF-24" }), line("Margherita", { quantity: 3, productCode: "CF-24" })];
  const on = beoKitchenChargesOf(kids, adults, true, read);
  assert.deepEqual(on.adults.map((c) => c.kind), ["with_kids", "charged"]);
  assert.equal(beoExtraHintOf(on.adults[0]!), "charged once, with the kids' line");
  // 2 × 400 + 3 × 175 for the kids, 3 × 400 for the adults' own.
  assert.equal(beoExtrasTotalOf([...on.kids, ...on.adults]), 80_000 + 52_500 + 120_000);
  assert.deepEqual(beoKitchenChargesOf(kids, adults, false, read).adults, [], "the switch off: the adults eat the kids' menu");
});

await check("the extras' total as the till will charge them; nothing said when the till's menu was not read", () => {
  const plan = [
    beoExtraChargeOf(line("Margherita", { quantity: 2, price: 450 }), "food", read),
    beoExtraChargeOf(line("Fries", { productCode: "CF-11" }), "food", read),
    beoExtraChargeOf(line("Durian pizza"), "food", read),
    beoExtraChargeOf(line("Margherita", { source: "set_menu" }), "food", read),
  ];
  assert.equal(beoExtrasTotalOf(plan), 90_000 + 17_500);
  assert.equal(beoExtrasTotalWords(107_500), "Extras charged at the till: ฿1,075");
  assert.equal(beoExtrasTotalWords(118_050), "Extras charged at the till: ฿1,180.5");
  assert.equal(hasExtraLines(plan), true);
  assert.equal(hasExtraLines([beoExtraChargeOf(line("Margherita", { source: "set_menu" }), "food", read)]), false, "SET lines alone: no extras' total");
  const notRead = beoExtraChargeOf(line("Fries", { productCode: "CF-11" }), "food", unread);
  assert.deepEqual(notRead, { kind: "unknown" });
  assert.equal(beoExtraHintOf(notRead), null, "the till's menu not read: nothing rather than a wrong figure");
  assert.equal(beoExtrasTotalOf([plan[0]!, notRead]), null, "and no total");
  assert.equal(beoExtraChargeOf(line("Fries", { productCode: "CF-11", price: 180 }), "food", unread).kind, "charged", "an entered price needs no till");
});

await check("the BEO PDF prints a drink's EXTRA price for each item, as the kitchen's (SCRUM-940 point 3)", async () => {
  const html = await beoPdfHtml({
    eventTitle: "ZZ TEST 949",
    eventDate: WEEKDAY,
    startTime: "14:00",
    status: "upcoming",
    kitchenPlan: { required: true, menus: { kids: [{ quantity: 2, itemName: "Margherita", price: 450 }] } },
    barPlan: {
      serviceTime: "14:15",
      items: [
        { quantity: 2, itemName: "Latte", price: 145 },
        { quantity: 10, itemName: "Juice jug", source: "set_menu", price: 90 },
        { quantity: 1, itemName: "Water" },
      ],
    },
  } as Parameters<typeof beoPdfHtml>[0]);
  assert.ok(html.includes("450฿ each"), "the kitchen's EXTRA, as before");
  const bar = html.slice(html.indexOf("<h2>Bar Plan</h2>"));
  assert.ok(bar.includes(">EXTRA</span> <span class=\"price\">145฿ each</span>"), "the drink's price for each item");
  assert.ok(!bar.includes("90฿ each"), "never on a SET line");
  assert.equal((bar.match(/ each<\/span>/g) ?? []).length, 1, "a line with no price prints none");
});

await check("the BEO PDF prints a set-menu choice with single brackets: Margherita (Pizza), never ((Pizza)) (SCRUM-940 point 3)", async () => {
  const kids = [
    { quantity: 1, itemName: "Margherita", notes: "(Pizza)", source: "set_menu", groupId: "g-pizza" },
    { quantity: 1, itemName: "Chicken", notes: "(Fried rice) · no onion", source: "set_menu", groupId: "g-rice" },
    { quantity: 2, itemName: "Margherita", notes: "cut small", source: "additional", price: 450 },
  ];
  const html = await beoPdfHtml({
    eventTitle: "ZZ TEST 940", eventDate: WEEKDAY, startTime: "14:00", status: "upcoming",
    kitchenPlan: { required: true, setMenuEnabled: true, setMenuTemplateName: "ZZ TEST set", menus: { kids } },
    barPlan: { items: [{ quantity: 1, itemName: "Juice", notes: "(Drinks pitcher)", source: "set_menu" }] },
  } as Parameters<typeof beoPdfHtml>[0]);
  assert.ok(html.includes("Margherita (Pizza)"), "the choice and its group");
  assert.ok(html.includes("Chicken (Fried rice) · no onion"), "a note after the group keeps one pair");
  assert.ok(html.includes("Juice <span class=\"item-note\">(Drinks pitcher)</span>"), "the bar too");
  assert.ok(html.includes("<span class=\"item-note\">(cut small)</span>"), "a plain note in brackets, as before");
  assert.equal(html.includes("(("), false, "never double brackets");
});

console.log(`beo-extra-price.check: ${checks} checks passed`);
