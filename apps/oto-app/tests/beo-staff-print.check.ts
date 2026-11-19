// seed: none — no database, no server, no browser. Not a Playwright file.
//
// SCRUM-1028 — the Staff BEO print rebuilt (server/pdf.ts beoPdfHtml), on the
// BEO as it is stored today, from ZZ TEST parties (tests/fixtures/beo-staff-print.ts):
//
//   1. the header: the party's name, day, times, room and park; the child, the
//      contact, the planned guests and the hosts; the package box with what the
//      package includes as its snapshot stores it, its lines and the till's
//      money (or why there is none); nothing yet for expected extra guests or
//      socks (SCRUM-1031 fills that place);
//   2. the ONE timeline (SCRUM-1027), with what is served and each person;
//   3. KITCHEN on the left: the kids' menu with every dish and its count; the
//      adults as their own list with their own counts when they eat differently,
//      one line when they eat the kids' menu; "no food" said plainly;
//   4. SETUP, BAR, ENTERTAINMENT (each activity: time, name, person), CAKE and
//      NOTES on the right, each only with something in it;
//   5. a dish with no count prints as 1; names print as stored; prices where the
//      page printed them before; a note's agreed amount as written;
//   6. an old event with only hand-typed timeline rows; a long order that runs
//      onto more pages (no part held whole, headings kept with what follows,
//      every page's foot naming the party and its page); Thai beside English;
//   7. the route hands the print the package snapshot and the activities.
//
// Run from apps/oto-app: npx tsx tests/beo-staff-print.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1028";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
// The PDF module reads the app's config, which wants a database address; nothing here connects to one.
process.env.DATABASE_URL ??= "postgres://zz-test-1028@127.0.0.1:1/none";

const { beoPdfHtml, beoPdfFooterTemplate, beoPdfTimelineOf } = await import("../server/pdf");
const { buildBeoTimeline } = await import("../shared/beoTimeline");
const { normalParty, longParty, thaiParty, dish, set } = await import("./fixtures/beo-staff-print");
type PdfData = import("../server/pdf").BeoPdfData;
type Menus = NonNullable<NonNullable<PdfData["kitchenPlan"]>["menus"]>;

const APP = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(APP + path, "utf8").replace(/\r\n/g, "\n");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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

/** One part of the page, from its mark to the next part's. */
const part = (html: string, name: string) => {
  const at = html.indexOf(`data-part="${name}"`);
  if (at < 0) return "";
  const next = html.indexOf("data-part=", at + 10);
  return html.slice(at, next < 0 ? undefined : next);
};
/** The text of each table row of a slice, tags aside ("2x Fruit skewers EXTRA 120฿ each"). */
const rowsOf = (html: string) =>
  html.split("<tr>").slice(1).map((r) => r.slice(0, r.indexOf("</tr>")).replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim());
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/&bull;/g, "•").replace(/\s+/g, " ").trim();
const kitchenWith = (menus: Record<string, unknown>, over: Partial<NonNullable<PdfData["kitchenPlan"]>> = {}): PdfData => ({
  ...normalParty,
  kitchenPlan: { ...normalParty.kitchenPlan!, setMenuEnabled: false, menus: menus as unknown as Menus, ...over },
});

const html = await beoPdfHtml(normalParty);

// ── 1. The header ────────────────────────────────────────────────────────────

await check("the header: the party's name, day, times, room, status and park", async () => {
  const head = html.slice(0, html.indexOf('data-part="party"'));
  for (const words of ["ZZ TEST Birthday Party", "5 December '99 &bull; 11:00 – 14:00", "ZZ TEST Party Room A", "confirmed", "ZZ TEST Park", "ZZ TEST address"]) {
    assert.ok(head.includes(words), words);
  }
  // When the page was made: under the park's name, never alone on a last page.
  assert.match(head, /<div class="generated">Generated \d{2}\/\d{2}\/\d{4} &bull; Banquet Event Order<\/div>/);
  assert.equal(html.slice(html.indexOf('class="columns"')).includes("Generated"), false);
});

await check("the header: the child, the contact, the planned guests and the hosts, as printed before", async () => {
  const facts = textOf(part(html, "party"));
  for (const words of ["Child: ZZ TEST Child", "Kid Turning Age: 6", "Booking Name: ZZ TEST Booking", "Parent: ZZ TEST Parent", "WhatsApp: ZZ TEST WhatsApp", "Children: 11", "Adults: 10", "Party Host: ZZ TEST Host Noi", "Backup: ZZ TEST Host Ben"]) {
    assert.ok(facts.includes(words), `${words} in ${facts}`);
  }
  // A role prints only for a party with no named host; a host with nothing named prints no line.
  const role = textOf(part(await beoPdfHtml({ ...normalParty, partyHost: { roleName: "ZZ TEST Hosts" } }), "party"));
  assert.ok(role.includes("Host role: ZZ TEST Hosts") && !role.includes("Party Host:"));
  const none = textOf(part(await beoPdfHtml({ ...normalParty, partyHost: { assignedName: undefined, backupName: undefined } }), "party"));
  assert.ok(!none.includes("Party Host") && !none.includes("Backup"));
});

await check("the header's package box: the package, what it includes as its snapshot stores it, its lines and the till's money", async () => {
  const pkg = part(html, "package");
  assert.ok(pkg.includes("<h2>POS: ZZ TEST Weekend Birthday</h2>"));
  assert.ok(textOf(pkg).includes("Included: 10 kids + 4 adults, play, basic program, cake (ice cream)"));
  assert.deepEqual(rowsOf(pkg).slice(0, 2), ["ZZ TEST Kids' table INCL", "ZZ TEST Photo zone (PRO) EXTRA"], "the lines as written, no price");
  assert.ok(pkg.includes("Till not reachable"), "no till: the reason, no figure");
  assert.ok(!/฿|\d,\d{3}/.test(textOf(pkg)), "no money of the app's own");
  assert.ok(pkg.includes("ZZ TEST POS note"));
  // A party with only a snapshot: its name and allowance; with none of the three: no box.
  const onlySnapshot = part(await beoPdfHtml({ ...normalParty, partyDetails: undefined, till: undefined, packageSnapshot: { packageName: "ZZ TEST Snapshot package", kidsIncluded: 8, adultsIncluded: null } }), "package");
  assert.ok(onlySnapshot.includes("<h2>POS: ZZ TEST Snapshot package</h2>") && textOf(onlySnapshot).includes("Included: 8 kids"));
  assert.equal(part(await beoPdfHtml({ ...normalParty, partyDetails: undefined, till: { status: "not_linked", message: "x" }, packageSnapshot: undefined }), "package"), "");
});

await check("nothing prints yet for expected extra guests or socks: their place in the header is empty", async () => {
  const head = textOf(html.slice(0, html.indexOf('data-part="timeline"')));
  assert.equal(/expected extra|socks/i.test(head), false, head);
  assert.match(code(read("server/pdf.ts")), /const laterHeaderFacts: string\[\] = \[\];/);
});

// ── 2. The parts in their places ─────────────────────────────────────────────

await check("the order of the page: header, the one timeline, Kitchen on the left; Setup, Bar, Entertainment, Cake, Notes on the right", async () => {
  const at = ["party", "package", "timeline", "kitchen", "setup", "bar", "entertainment", "cake", "notes"].map((p) => html.indexOf(`data-part="${p}"`));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  const left = html.slice(html.indexOf('class="col-left"'), html.indexOf('class="col-right"'));
  assert.ok(left.includes('data-part="kitchen"') && !left.includes('data-part="setup"'));
  const right = html.slice(html.indexOf('class="col-right"'));
  for (const p of ["setup", "bar", "entertainment", "cake", "notes"]) assert.ok(right.includes(`data-part="${p}"`), p);
  for (const h of ["<h2>Timeline</h2>", "<h2>Kitchen</h2>", "<h2>Setup</h2>", "<h2>Bar</h2>", "<h2>Entertainment</h2>", "<h2>Cake</h2>", "<h2>Notes</h2>"]) assert.ok(html.includes(h), h);
});

await check("the one timeline: every step in time order with what is served and its person; the untimed act listed", async () => {
  const tl = rowsOf(part(html, "timeline")).slice(1);
  assert.deepEqual(tl.map((r) => r.split(" ")[0]), ["10:00", "11:00", "11:30", "11:30", "12:00", "12:15", "13:00", "13:30", "13:30", "14:00"]);
  assert.ok(tl[2]!.startsWith("11:30 Kids' menu served 1x Hawaiian, 1x Margherita, 1x Pepperoni, 1x Fried rice, 1x Fish fingers, 3x French fries, 2x Fruit skewers, 2x Vegetable sticks, 1x Mini waffles"), tl[2]);
  assert.equal(tl[3], "11:30 Drinks Service 2x Mors, 2x Lemonade, 1x Water");
  assert.equal(tl[4], "12:00 ZZ TEST Bubble show · ZZ TEST Host Noi");
  assert.equal(tl[5], "12:15 Adults' menu served 2x Smoked Salmon Pizza, 3x Caesar salad, 1x Chicken wings");
  assert.equal(tl[8], "13:30 ZZ TEST Pinata", "the hand-typed step at its time");
  assert.match(part(html, "timeline"), /No time set: ZZ TEST Magic/);
});

// ── 3. Kitchen ───────────────────────────────────────────────────────────────

await check("the kids' menu: the set menu's choices by name with their counts, then the additional items", async () => {
  const k = part(html, "kitchen");
  assert.match(textOf(k), /Kids Menu \(11 kids\) — Service: 11:30/);
  assert.match(textOf(k), /Set Menu ZZ TEST Set Central — Received 30 Nov/);
  const rows = rowsOf(k);
  assert.deepEqual(rows.slice(0, 6), [
    "1x Hawaiian (Pizza 1) SET", "1x Margherita (Pizza 2) SET", "1x Pepperoni (Pizza 3) SET", "1x Fried rice (Rice) SET", "1x Fish fingers (Fish) SET", "3x French fries (Sides) SET",
  ]);
  assert.ok(k.indexOf("Additional Items") > k.indexOf("French fries"));
  assert.equal(rows[6], "2x Fruit skewers EXTRA 120฿ each");
  assert.equal(rows[7], "2x Vegetable sticks (no dip) EXTRA 90฿ each");
  assert.ok(rows[8]!.startsWith("1x Mini waffles EXTRA"), "a dish with no count is one");
  assert.ok(k.includes("ZZ TEST kitchen note: pizzas cut in eight"));
});

await check("the adults eating differently: their own list with their own counts and prices, never marks on the kids' rows", async () => {
  const k = part(html, "kitchen");
  assert.match(textOf(k), /Adults Menu \(10 adults\) — Service: 12:15/);
  const adults = rowsOf(k.slice(k.indexOf('data-adults="differ"')));
  assert.deepEqual(adults, ["2x Smoked Salmon Pizza EXTRA 450฿ each", "3x Caesar salad EXTRA 220฿ each", "1x Chicken wings EXTRA 180฿ each"]);
  assert.equal(/kids only|adults only|kids \d+ · adults \d+|Adults: same/.test(textOf(k)), false);
  // The same dish for both at its own count: one row in each list.
  const both = part(await beoPdfHtml(kitchenWith({ kids: [dish("Margherita", 3, { price: 400 })], adults: [dish("Margherita", 2, { price: 450 })], adultsDiffer: true })), "kitchen");
  assert.deepEqual(rowsOf(both), ["3x Margherita EXTRA 400฿ each", "2x Margherita EXTRA 450฿ each"]);
  assert.ok(both.indexOf("Adults Menu") > both.indexOf("3x"), "the adults' row under their own heading");
  // The adults' copy of a kids' line (same name, count and code) is charged once, with the kids'
  // line, as the editor and the till have it: its row says so instead of a second price.
  const copy = part(await beoPdfHtml(kitchenWith({ kids: [dish("Margherita", 2, { price: 400, productCode: "CF-24" })], adults: [dish("Margherita", 2, { price: 450, productCode: "CF-24" }), dish("Steak", 1, { price: 500 })], adultsDiffer: true })), "kitchen");
  assert.deepEqual(rowsOf(copy), ["2x Margherita EXTRA 400฿ each", "2x Margherita EXTRA charged once, with the kids' line", "1x Steak EXTRA 500฿ each"]);
  // Switched on with no dish of their own: said, not left blank.
  assert.match(textOf(part(await beoPdfHtml(kitchenWith({ kids: [dish("Margherita", 3)], adults: [], adultsDiffer: true })), "kitchen")), /Adults Menu \(10 adults\) No dishes listed for the adults\./);
});

await check("the adults eating the kids' menu ('Same as kids'): one line under the kids' rows, no list of their own", async () => {
  const k = part(await beoPdfHtml(kitchenWith({ kids: [dish("Nuggets", 8), dish("Fries", 2, { notes: "no salt" })], adults: [], adultsDiffer: false, kidsFoodTime: "11:30", adultsFoodTime: "12:00" })), "kitchen");
  assert.deepEqual(rowsOf(k).map((r) => r.replace(/ EXTRA.*$/, "")), ["8x Nuggets", "2x Fries (no salt)"]);
  assert.match(textOf(k), /Adults: same as the kids' menu — Service: 12:00/);
  assert.equal(k.includes("Adults Menu"), false);
  // A list saved before the switch that only repeats the kids' dishes is the kids' menu too.
  const copies = part(await beoPdfHtml(kitchenWith({ kids: [dish("Nuggets", 8)], adults: [dish("Nuggets", 8)] })), "kitchen");
  assert.ok(copies.includes('data-adults="same"') && !copies.includes("Adults Menu"));
});

await check("a party with no food says so plainly: kitchen not needed, no kitchen plan, or nothing on it", async () => {
  const notNeeded = await beoPdfHtml(kitchenWith({ kids: [dish("Nuggets", 8)] }, { required: false }));
  const said = textOf(part(notNeeded, "kitchen").slice(0, part(notNeeded, "kitchen").lastIndexOf("</div>")));
  assert.match(said, /> Kitchen No food for this party: kitchen not needed\.$/, "the line and nothing else");
  assert.ok(part(notNeeded, "cake").includes("Our cake (provided)"), "the cake keeps its own part");
  assert.match(textOf(part(await beoPdfHtml({ ...normalParty, kitchenPlan: undefined }), "kitchen")), /No food ordered\./);
  assert.match(textOf(part(await beoPdfHtml(kitchenWith({ kids: [], adults: [] })), "kitchen")), /No food ordered\./);
  assert.equal(part(notNeeded, "kitchen").includes("<tr>"), false);
});

// ── 4. The right column ──────────────────────────────────────────────────────

await check("Setup: ready by, who, the decoration, each task with its note, the setup notes", async () => {
  const sp = part(html, "setup");
  const t = textOf(sp);
  for (const words of ["Ready By: 10:00", "Who: ZZ TEST Setup team", "Decoration: ZZ TEST unicorn balloons", "ZZ TEST one long table for the kids"]) assert.ok(t.includes(words), words);
  assert.deepEqual(rowsOf(sp), ["Task Notes", "ZZ TEST Balloon arch pink and gold", "ZZ TEST Table cloths"]);
});

await check("Bar: the service time and the full order with counts; a SET drink and a drink with no count", async () => {
  const b = part(html, "bar");
  assert.ok(textOf(b).includes("Service Time: 11:30"));
  const rows = rowsOf(b);
  assert.deepEqual(rows.slice(0, 2), ["2x Mors SET", "2x Lemonade EXTRA 90฿ each"]);
  assert.ok(rows[2]!.startsWith("1x Water EXTRA"));
});

await check("Entertainment: each activity with its time and its own person; one with no time says so; the program and the activities text", async () => {
  const e = part(html, "entertainment");
  assert.deepEqual(rowsOf(e), ["12:00 ZZ TEST Bubble show ZZ TEST Host Noi", "13:00 ZZ TEST Treasure hunt ZZ TEST Floor team", "No time set ZZ TEST Magic"]);
  assert.ok(textOf(e).includes("Program: ZZ TEST Basic program") && textOf(e).includes("Activities: ZZ TEST games and dancing"));
  // An act with no name of its own: the timeline's word for it; a time stored as 9:05: written 09:05.
  const unnamed = part(await beoPdfHtml({ ...normalParty, entertainmentActs: [{ id: "x", customName: "  ", startTime: "9:05", person: null }] }), "entertainment");
  assert.deepEqual(rowsOf(unnamed), ["09:05 Entertainment"]);
});

await check("Cake: what it is, INCL or EXTRA with the price it printed with, its time and notes; the event's own cake notes", async () => {
  const c = textOf(part(html, "cake"));
  assert.match(c, /Our cake \(provided\) INCL — Time: 13:30 — Mix flavour/);
  const extra = textOf(part(await beoPdfHtml({ ...normalParty, cakeNotes: "ZZ TEST candles: 6", kitchenPlan: { ...normalParty.kitchenPlan!, cakeMode: "EXTERNAL", cakeQuantity: 2, cakeIncluded: false, cakePrice: 500 } }), "cake"));
  assert.match(extra, /Own cake \(guest brings\) x2 EXTRA 500฿ — Time: 13:30/);
  assert.match(extra, /Cake Notes: ZZ TEST candles: 6/);
  assert.equal(part(await beoPdfHtml({ ...normalParty, kitchenPlan: { ...normalParty.kitchenPlan!, cakeMode: "NONE" } }), "cake"), "", "no cake: no part");
});

await check("Notes: the allergies and the special requests as written, an agreed amount included", async () => {
  const t = textOf(part(html, "notes"));
  assert.ok(t.includes("Allergies & Dietary Notes ZZ TEST: one child has a nut allergy"));
  assert.ok(t.includes("Special Requests ZZ TEST: Preordered food (฿7,290) agreed with the family"));
});

await check("a part with nothing in it prints no heading (SCRUM-978), and an old event with only typed rows still prints them", async () => {
  const old = await beoPdfHtml({
    eventTitle: "ZZ TEST old", eventDate: "2099-12-05", startTime: "14:00", status: "confirmed",
    ...beoPdfTimelineOf(buildBeoTimeline({ startTime: "14:00", rows: [{ id: "r1", label: "ZZ Speech", offsetFromStartMinutes: 60, isSystemGenerated: false, sourceKey: null, isCompleted: false, sortOrder: 1, assignedToType: "PARTY_HOST" }] })),
  });
  assert.match(old, /15:00<\/td>\s*<td>ZZ Speech/);
  for (const h of ["Setup", "Bar", "Entertainment", "Cake", "Notes", "POS"]) assert.equal(old.includes(`<h2>${h}`), false, h);
  assert.equal(old.includes('data-part="party"'), false, "no facts: no empty box");
  assert.match(textOf(part(old, "kitchen")), /No food ordered\./);
});

// ── 5. Counts, names, prices ─────────────────────────────────────────────────

await check("a dish with no count prints as 1, never null or undefined; names print as stored", async () => {
  const page = await beoPdfHtml(kitchenWith({ kids: [dish("ZZ TEST no count"), { ...dish("ZZ TEST null count"), quantity: null }, set("ZZ TEST set no count", "Pizza 1")] }, { setMenuEnabled: true }));
  const rows = rowsOf(part(page, "kitchen"));
  assert.ok(rows.includes("1x ZZ TEST set no count (Pizza 1) SET"), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.startsWith("1x ZZ TEST no count EXTRA")) && rows.some((r) => r.startsWith("1x ZZ TEST null count EXTRA")));
  assert.equal(/nullx|undefinedx|NaNx/.test(page), false);
});

// ── 6. Long orders, pages, Thai ──────────────────────────────────────────────

await check("a long order: every dish, drink and act printed; nothing held whole; headings kept with what follows", async () => {
  const long = longParty();
  const page = await beoPdfHtml(long);
  const k = part(page, "kitchen");
  const adultsAt = k.indexOf('data-adults="differ"');
  assert.equal(rowsOf(k.slice(0, adultsAt)).length, 6 + 34, "every kids' dish");
  assert.equal(rowsOf(k.slice(adultsAt)).length, 22, "every adults' dish");
  assert.equal(rowsOf(part(page, "bar")).length, 28, "every drink");
  assert.equal(rowsOf(part(page, "entertainment")).length, 9, "every act");
  assert.ok(page.includes("ZZ TEST adults dish with a long name that has to wrap inside its column 22"));
  // The page's rules: the kitchen and the timeline may run onto the next page; a row is never cut;
  // a heading is never left alone at a page's foot; table heads repeat; long words wrap.
  assert.equal(/class="part (?:kitchen|timeline)-part[^"]*box/.test(page), false);
  assert.match(page, /tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(page, /h2 \{[^}]*break-after: avoid; page-break-after: avoid;/);
  assert.match(page, /h3 \{[^}]*break-after: avoid; page-break-after: avoid;/);
  assert.match(page, /thead \{ display: table-header-group; \}/);
  assert.match(page, /\.menu-table \{[^}]*table-layout: fixed;/);
  assert.match(page, /td, p, \.info-value, h3 \{ overflow-wrap: break-word;/);
  assert.equal(/\.section \{[^}]*page-break-inside: avoid/.test(page), false, "no part is held whole any more");
});

await check("every page's foot names the party, its day and time, and the page: Page n of m", async () => {
  const foot = beoPdfFooterTemplate({ eventTitle: "ZZ TEST <b>Party</b> & co", eventDate: "2099-12-05", startTime: "11:00", endTime: "14:00" });
  assert.ok(foot.includes("Staff BEO &bull; ZZ TEST &lt;b&gt;Party&lt;/b&gt; &amp; co &bull; 5 December &#39;99 11:00 – 14:00"), foot);
  assert.match(foot, /Page <span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/);
  const gen = code(read("server/pdf.ts"));
  const fn = gen.slice(gen.indexOf("export async function generateBeoPdf("));
  assert.match(fn, /displayHeaderFooter: true,/);
  assert.match(fn, /footerTemplate: beoPdfFooterTemplate\(data\),/);
  assert.match(fn, /format: "A4",/);
});

await check("Thai beside English: printed as written, in fonts that carry Thai", async () => {
  const page = await beoPdfHtml(thaiParty);
  assert.match(page, /<meta charset="UTF-8">/);
  for (const words of ["ZZ TEST งานวันเกิด น้องทดสอบ", "Child:</span><span class=\"info-value\">ZZ TEST น้องทดสอบ", "ZZ TEST ขอเค้กช็อกโกแลต และ a quiet corner"]) assert.ok(page.includes(words), words);
  assert.deepEqual(rowsOf(part(page, "kitchen")).map((r) => r.replace(/ EXTRA.*$/, "")), ["4x ข้าวผัดไก่ (ไม่เผ็ด)", "2x French fries"]);
  assert.match(page, /font-family: 'Helvetica Neue', Arial, 'Noto Sans Thai', Loma, Garuda, 'Leelawadee UI', Tahoma, sans-serif;/);
  assert.match(beoPdfFooterTemplate(thaiParty), /ZZ TEST งานวันเกิด น้องทดสอบ/);
  // The app's image installs the Thai fonts the stack names (Loma and Garuda are fonts-thai-tlwg's).
  assert.match(read("Dockerfile"), /fonts-thai-tlwg/);
});

// ── 7. The route ─────────────────────────────────────────────────────────────

await check("the PDF route hands the print the package snapshot and each activity with its own person", async () => {
  const routes = code(read("server/beo-routes.ts"));
  const route = routes.slice(routes.indexOf('app.get("/api/events/:eventId/beo/pdf"'), routes.indexOf("generateBeoPdf(pdfData)"));
  assert.match(route, /packageSnapshot: pdfPkgSnapshot \? \{/);
  assert.match(route, /kidsIncluded: pdfPkgSnapshot\.kidsIncluded,/);
  assert.match(route, /entertainmentActs: await beoActivitiesOf\(event\.tenantId, entertainmentItems\),/);
  assert.ok(route.indexOf("verifyEventAccess(eventId, req.userWithAccess)") < route.indexOf("beoActivitiesOf("), "the event's access first");
  const reader = code(read("server/lib/beoTimelineRead.ts"));
  assert.match(reader, /export async function beoActivitiesOf\(/);
  assert.match(reader, /\? await beoActivitiesOf\(event\.tenantId, acts\)/, "the timeline reads the same people");
});

console.log(`\n${checks} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
process.exit(0);
