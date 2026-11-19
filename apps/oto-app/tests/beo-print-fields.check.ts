// seed: none — no database, no server, no browser. Not a Playwright file.
//
// The Staff BEO print (server/pdf.ts beoPdfHtml) with the BEO's new fields and
// the owner's answers of 19 November, from ZZ TEST parties only
// (tests/fixtures/beo-staff-print.ts):
//
//   1. SCRUM-1030, Kitchen Notes: at the very top of the Kitchen, before the
//      menus, under their label, as written (Thai beside English, wrapping);
//      empty prints nothing; with the kitchen Not Needed, nothing, as before;
//   2. SCRUM-1031, the socks arrangement and the expected extra guests in the
//      header, in the brief's words; none stored prints nothing;
//   3. SCRUM-1042, the birthday package's waffles read "Adult Waffles"; a dish
//      typed by hand, a drink and any other dish keep their names; the stored
//      lines are not changed by printing;
//   4. SCRUM-1050: a set line whose name carries its count prints no "1x"; the
//      set menu's group label beside a dish (R13); an EXTRA the till does not
//      charge carries a mark, its words once under its list (R24).
//
// Run from apps/oto-app: npx tsx tests/beo-print-fields.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1030";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
// The PDF module reads the app's config, which wants a database address; nothing here connects to one.
process.env.DATABASE_URL ??= "postgres://zz-test-1030@127.0.0.1:1/none";

const { beoPdfHtml } = await import("../server/pdf");
const { beoExtraHintOf, beoExtraChargeOf } = await import("../shared/beoExtras");
const { normalParty, thaiParty, dish, set } = await import("./fixtures/beo-staff-print");
type PdfData = import("../server/pdf").BeoPdfData;
type Menus = NonNullable<NonNullable<PdfData["kitchenPlan"]>["menus"]>;

let checks = 0;
const failed: string[] = [];
const check = async (title: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    checks += 1;
    console.log(`  ok  ${title}`);
  } catch (error) {
    failed.push(title);
    console.log(`  FAIL  ${title}\n${error instanceof Error ? error.message : String(error)}`);
  }
};

const part = (html: string, name: string) => {
  const at = html.indexOf(`data-part="${name}"`);
  if (at < 0) return "";
  const next = html.indexOf("data-part=", at + 10);
  return html.slice(at, next < 0 ? undefined : next);
};
const rowsOf = (html: string) =>
  html.split("<tr>").slice(1).map((r) => r.slice(0, r.indexOf("</tr>")).replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim());
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/&bull;/g, "•").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const kitchenWith = (menus: Record<string, unknown>, over: Partial<NonNullable<PdfData["kitchenPlan"]>> = {}, party: Partial<PdfData> = {}): PdfData => ({
  ...normalParty,
  ...party,
  kitchenPlan: { ...normalParty.kitchenPlan!, setMenuEnabled: false, menus: menus as unknown as Menus, ...over },
});
const header = (html: string) => html.slice(0, html.indexOf('data-part="timeline"'));
const UNRESOLVED = beoExtraHintOf({ kind: "not_charged", why: "no_price" })!;

// ── 1. Kitchen Notes ─────────────────────────────────────────────────────────

await check("SCRUM-1030: the Kitchen Notes print at the very top of the Kitchen, before the menus, under their label", async () => {
  const k = part(await beoPdfHtml(normalParty), "kitchen");
  const t = textOf(k).replace(/^data-part="kitchen">\s*/, "");
  assert.ok(t.startsWith("Kitchen Kitchen Notes: ZZ TEST kitchen note: pizzas cut in eight Kids Menu"), t.slice(0, 120));
  assert.ok(k.indexOf("data-kitchen-notes") < k.indexOf("Kids Menu"), "before the kids' menu");
  assert.ok(k.indexOf("data-kitchen-notes") < k.indexOf("Adults Menu"), "before the adults' menu");
  assert.equal(k.split("Kitchen Notes:").length - 1, 1, "once");
});

await check("SCRUM-1030: Thai beside English as written; a long note wraps (pre-wrap, words broken only to fit)", async () => {
  const words = "ZZ TEST ทำอาหารเด็กก่อนแขกมา and serve the adults' food in two stages\nZZ TEST second line";
  const page = await beoPdfHtml(kitchenWith(thaiParty.kitchenPlan!.menus as unknown as Record<string, unknown>, { notes: words }, { eventTitle: thaiParty.eventTitle }));
  const k = part(page, "kitchen");
  assert.ok(k.includes("ZZ TEST ทำอาหารเด็กก่อนแขกมา and serve the adults&#39; food in two stages\nZZ TEST second line") || k.includes("ZZ TEST ทำอาหารเด็กก่อนแขกมา and serve the adults' food in two stages\nZZ TEST second line"), k.slice(0, 400));
  assert.match(page, /\.notes \{[^}]*white-space: pre-wrap;/);
  assert.match(page, /td, p, \.info-value, h3 \{ overflow-wrap: break-word;/);
  assert.match(page, /<p class="notes kitchen-notes" data-kitchen-notes>/);
});

await check("SCRUM-1030: empty or blank Kitchen Notes print nothing; with the kitchen Not Needed, nothing, as before", async () => {
  for (const notes of [undefined, "", "   \n  "]) {
    const k = part(await beoPdfHtml(kitchenWith(normalParty.kitchenPlan!.menus as unknown as Record<string, unknown>, { notes, setMenuEnabled: true })), "kitchen");
    assert.equal(k.includes("Kitchen Notes"), false, JSON.stringify(notes));
    assert.ok(k.includes("Kids Menu"), "the menus still print");
  }
  const notNeeded = part(await beoPdfHtml(kitchenWith({ kids: [dish("Nuggets", 8)] }, { required: false })), "kitchen");
  assert.equal(notNeeded.includes("Kitchen Notes"), false);
});

// ── 2. The socks arrangement and the expected extra guests ──────────────────

await check("SCRUM-1031: each socks arrangement prints in the brief's words in the header's facts", async () => {
  const cases: Array<[Partial<PdfData>, string]> = [
    [{ socksArrangement: "birthday_parent" }, "Socks arrangement: Birthday Parent Pays"],
    [{ socksArrangement: "guests" }, "Socks arrangement: Guests Pay Individually"],
    [{ socksArrangement: "other" }, "Socks arrangement: Other / Custom"],
    [{ socksArrangement: "other", socksNote: "ZZ TEST grandma pays for the cousins" }, "Socks arrangement: Other / Custom: ZZ TEST grandma pays for the cousins"],
    [{ socksArrangement: "other", socksNote: "ZZ TEST ถุงเท้า paid by the school" }, "Socks arrangement: Other / Custom: ZZ TEST ถุงเท้า paid by the school"],
  ];
  for (const [over, words] of cases) {
    const facts = textOf(part(await beoPdfHtml({ ...normalParty, ...over }), "party"));
    assert.ok(facts.includes(words), `${words} in ${facts}`);
  }
  // The note belongs to Other / Custom; an option the party cannot store prints nothing.
  const guestsWithNote = textOf(part(await beoPdfHtml({ ...normalParty, socksArrangement: "guests", socksNote: "ZZ TEST stray" }), "party"));
  assert.ok(guestsWithNote.includes("Socks arrangement: Guests Pay Individually") && !guestsWithNote.includes("ZZ TEST stray"));
  for (const socksArrangement of [null, undefined, "", "pay_at_reception"]) {
    assert.equal(/socks/i.test(textOf(header(await beoPdfHtml({ ...normalParty, socksArrangement })))), false, String(socksArrangement));
  }
});

await check("SCRUM-1031: the expected extra guests print on their own line in the facts box; none, or noughts, print nothing", async () => {
  const cases: Array<[Partial<PdfData>, string]> = [
    [{ expectedExtraKids: 1, expectedExtraAdults: 6 }, "Expected extra (add to POS on arrival): +1 child · +6 adults"],
    [{ expectedExtraKids: 2, expectedExtraAdults: 1 }, "Expected extra (add to POS on arrival): +2 children · +1 adult"],
    [{ expectedExtraKids: 3 }, "Expected extra (add to POS on arrival): +3 children"],
    [{ expectedExtraKids: 0, expectedExtraAdults: 4 }, "Expected extra (add to POS on arrival): +4 adults"],
  ];
  for (const [over, words] of cases) {
    const page = await beoPdfHtml({ ...normalParty, ...over });
    const facts = part(page, "party");
    assert.ok(textOf(facts).includes(words), `${words} in ${textOf(facts)}`);
    assert.equal(facts.split('data-fact="expected-extra"').length - 1, 1, "one line");
    assert.ok(page.indexOf('data-fact="expected-extra"') < page.indexOf('data-part="timeline"'), "in the header");
  }
  for (const over of [{}, { expectedExtraKids: 0, expectedExtraAdults: 0 }, { expectedExtraKids: null, expectedExtraAdults: null }]) {
    const head = header(await beoPdfHtml({ ...normalParty, ...over }));
    assert.equal(/expected extra/i.test(textOf(head)), false, JSON.stringify(over));
  }
  // A party with nothing else in its facts still prints the two (a box of their own).
  const bare = await beoPdfHtml({ eventTitle: "ZZ TEST bare", eventDate: "2099-12-05", startTime: "11:00", status: "confirmed", expectedExtraAdults: 2, socksArrangement: "guests" });
  assert.match(textOf(part(bare, "party")), /Socks arrangement: Guests Pay Individually Expected extra \(add to POS on arrival\): \+2 adults/);
  // Information only: neither touches the package box's money.
  const pkg = textOf(part(await beoPdfHtml({ ...normalParty, expectedExtraKids: 1, expectedExtraAdults: 6, socksArrangement: "birthday_parent" }), "package"));
  assert.equal(pkg, textOf(part(await beoPdfHtml(normalParty), "package")));
});

// ── 3. Adult Waffles ─────────────────────────────────────────────────────────

/** A set menu's choice as the parent's link, AI Fill's approval or the till store it (shared/tillMenu.ts isTemplateSetMenuLine). */
const chosen = (itemName: string, group: string, quantity?: number) => ({ ...set(itemName, group, quantity), groupId: `item_zz_${group.replace(/\W+/g, "_")}` });

await check("SCRUM-1042: the birthday package's waffles read Adult Waffles; a typed dish, a SET line typed by hand and a drink keep their names", async () => {
  const kids = [
    chosen("Mini Waffles", "Sweets x2"),
    dish("Mini waffles", 2),
    { ...dish("Mini Waffles", 1), source: "set_menu", included: true },
    chosen("Mini Pancakes", "Sweets x2"),
  ];
  const adults = [{ ...chosen("Mini Waffles", "Sweets x2"), id: "zz-adult-copy" }, dish("Steak", 1, { price: 500 })];
  const menus = { kids, adults, adultsDiffer: true };
  const before = JSON.stringify(menus);
  const page = await beoPdfHtml(kitchenWith(menus, { setMenuEnabled: true }, {
    barPlan: { serviceTime: "11:30", items: [{ itemName: "Mini Waffles", quantity: 1, source: "set_menu" }] },
  }));
  const k = rowsOf(part(page, "kitchen"));
  assert.ok(k.includes("1x Adult Waffles (Sweets x2) SET"), JSON.stringify(k));
  assert.ok(k.some((r) => r.startsWith("2x Mini waffles EXTRA")), "an extra typed by hand keeps its name");
  assert.ok(k.includes("1x Mini Waffles SET"), "a SET line typed by hand (no group of the set menu) keeps its name");
  assert.ok(k.includes("1x Mini Pancakes (Sweets x2) SET"), "the other choice keeps its name");
  const adultsRows = rowsOf(part(page, "kitchen").slice(part(page, "kitchen").indexOf('data-adults="differ"')));
  assert.equal(adultsRows[0], "1x Adult Waffles (Sweets x2) SET", "the adults' copy of the package's item");
  assert.ok(rowsOf(part(page, "bar")).includes("1x Mini Waffles SET"), "the bar's lines are never renamed");
  assert.equal(JSON.stringify(menus), before, "printing changes no stored line");
});

// ── 4. SCRUM-1050: the count rule, the group label, the unresolved mark ─────

await check("SCRUM-1050: a set line whose stored name carries its count prints no '1x'; every other line with no count prints 1x", async () => {
  const kids = [
    { ...set("French fries x3", "Sides"), notes: "" },
    { ...set("Fruit skewers x2", "Sides", 1), notes: "" },
    { ...set("Vegetable sticks ×2", "Sides"), notes: "" },
    { ...set("2x Pizza Margherita", "Pizza"), notes: "" },
    { ...set("Chicken nuggets x3", "Mains", 2), notes: "" },
    set("Hawaii", "Pizza 1"),
    dish("Fries x3"),
    dish("Plain fries"),
    { ...set("Box 3", "Mains"), notes: "" },
  ];
  const rows = rowsOf(part(await beoPdfHtml(kitchenWith({ kids }, { setMenuEnabled: true })), "kitchen"));
  assert.deepEqual(rows.slice(0, 6), [
    "French fries x3 SET",
    "Fruit skewers x2 SET",
    "Vegetable sticks ×2 SET",
    "2x Pizza Margherita SET",
    "2x Chicken nuggets x3 SET",
    "1x Hawaii (Pizza 1) SET",
  ]);
  assert.ok(rows.some((r) => r.startsWith("1x Fries x3 EXTRA")), "only a set-menu line: a typed extra still prints 1x");
  assert.ok(rows.some((r) => r.startsWith("1x Plain fries EXTRA")));
  assert.ok(rows.includes("1x Box 3 SET"), "a number that is not a count keeps its 1x");
});

await check("SCRUM-1050, R13: a set-menu choice prints its group's label beside it, once, in one pair of brackets", async () => {
  const rows = rowsOf(part(await beoPdfHtml(kitchenWith({ kids: [set("Margherita", "Pizza 2"), { ...set("Hawaii", "Pizza 1"), notes: "(Pizza 1)" }] }, { setMenuEnabled: true })), "kitchen"));
  assert.deepEqual(rows, ["1x Margherita (Pizza 2) SET", "1x Hawaii (Pizza 1) SET"]);
});

await check("SCRUM-1050, R24: an EXTRA the till does not charge carries a mark; the words print once under its list; nothing else changes", async () => {
  // Two unresolved dishes (one kids', one adults') and one in the bar; a priced dish; a coded one the till did not price.
  const kids = [dish("ZZ TEST cupcakes", 2), dish("Fruit skewers", 2, { price: 120 }), dish("ZZ TEST coded", 1, { productCode: "CF-99" })];
  const adults = [dish("ZZ TEST cheese plate", 1)];
  const page = await beoPdfHtml(kitchenWith({ kids, adults, adultsDiffer: true }, {}, {
    barPlan: { serviceTime: "11:30", items: [{ itemName: "ZZ TEST punch", quantity: 3 }, { itemName: "Mors", quantity: 2, source: "set_menu" }] },
  }));
  const k = part(page, "kitchen");
  const rows = rowsOf(k);
  assert.ok(rows.includes("2x ZZ TEST cupcakes EXTRA *"), JSON.stringify(rows));
  assert.ok(rows.includes("1x ZZ TEST cheese plate EXTRA *"), JSON.stringify(rows));
  assert.ok(rows.includes("2x Fruit skewers EXTRA 120฿ each"), "a priced line as before");
  assert.ok(rows.includes("1x ZZ TEST coded EXTRA Price unresolved"), "a coded line the till's menu did not price: as before");
  assert.equal(k.split(UNRESOLVED).length - 1, 1, "the words once in the Kitchen");
  const note = k.slice(k.indexOf("<p class=\"mark-note\""), k.indexOf("</p>", k.indexOf("<p class=\"mark-note\"")) + 4);
  assert.equal(textOf(note), `* ${UNRESOLVED}`, "beside the mark");
  assert.ok(k.indexOf("data-unresolved-note") > k.lastIndexOf("</tr>"), "under the lists: after every row of the Kitchen");
  const b = part(page, "bar");
  assert.ok(rowsOf(b).includes("3x ZZ TEST punch EXTRA *"));
  assert.equal(b.split(UNRESOLVED).length - 1, 1, "the words once in the Bar");
  // A list with no such line says nothing of it.
  const none = await beoPdfHtml(kitchenWith({ kids: [dish("Fruit skewers", 2, { price: 120 })] }, {}, { barPlan: { serviceTime: "11:30", items: [{ itemName: "Mors", quantity: 2, source: "set_menu" }] } }));
  assert.equal(none.includes(UNRESOLVED), false);
  assert.equal(none.includes("data-unresolved-note"), false);
  // The words and when a line counts so are the editor's own rule, unchanged.
  assert.equal(UNRESOLVED, "Price unresolved - not charged");
  const ctx = { till: { known: false, byCode: new Map() }, partyDate: "2099-12-05" };
  assert.deepEqual(beoExtraChargeOf({ itemName: "ZZ TEST cupcakes", quantity: 2 }, "food", ctx), { kind: "not_charged", why: "no_price" });
  assert.deepEqual(beoExtraChargeOf({ itemName: "Fruit skewers", quantity: 2, price: 120 }, "food", ctx).kind, "charged");
});

console.log(`\n${checks} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
