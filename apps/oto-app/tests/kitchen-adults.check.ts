// seed: its own — one ZZ TEST park group, made here. Not a Playwright file: it
// mounts the BEO's own routes and the AI routes on a bare server (a stub
// model) and needs a database whose otoapp schema the app's migrator has
// built (0048 included).
//
// SCRUM-829 — the kids' menu is the main selection; the adults mirror it, the
// server's and the data's half (the form's is tests/kitchen-adults-ui.check.ts):
//
//   - the stored shape (shared/kitchenAdults.ts): a BEO saved with the switch
//     off keeps no adults' list; one saved with it on keeps the adults' own
//     list and adultsDiffer: true; a BEO saved before the switch opens on
//     only when its adults' list holds lines that are not the kids' list;
//     every server write records the switch as its readers resolve it — an
//     editor from before the switch, or the day-of view's own route, sending
//     none gets the key its lists say — so the till, the editor and the PDF
//     read one plan one way;
//   - the AI fill: both prompts tell the model the adults eat the kids' menu
//     unless the message says otherwise, and that the adults' list is then
//     everything the adults eat (a shared dish given again); the
//     required-fields block still names every line key; a stub model
//     answering one list leaves the form with no adults' list, one answering
//     the adults' own dish carries it; a catalogue dish with no list is the
//     kids'; Approve and create turns the switch on only when it writes an
//     adults' line, and a shared dish answered again is no "kids only";
//   - the till's plan view (migration 0048): a party saved before the switch
//     and never written since reads exactly as 0047 read it; with the switch
//     on, a coded kids' line copied for the adults reaches the till ONCE
//     whatever its note (the adults' note, or its clearing, carried on that
//     one line), a line the adults do not get is marked "kids", an adults'
//     line in another count or of a new name is marked "adults" (coded or
//     not) and an uncoded kids' line the adults get in another count is
//     emitted beside it, and a set-menu line never written into the kids'
//     list is left unmarked;
//   - the set menu's lines stay in step for the adults' own list: the parent
//     link's submit after the switch writes the same resolved lines into it,
//     a Save with a stale submission takes the parent's lines for the adults
//     too, and an approval with a set menu copies the lines for the adults;
//   - the BEO PDF prints ONE food list: "Adults: same as the kids' menu" with
//     the switch off; with it on, the adults' changes marked beside the kids'
//     lines and their own dishes after, marked "adults only" — never a second
//     Adults Menu table.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> npx tsx tests/kitchen-adults.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("kitchen-adults.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-829";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const {
  ADULTS_NO_NOTE_MARK, ADULTS_ONLY_MARK, ADULTS_SAME_AS_KIDS, KIDS_ONLY_MARK,
  adultsCopiesOf, adultsCountMark, adultsDifferOf, adultsListOf, adultsNoteMark, kitchenAdultsMarks, kitchenListsEqual, sameKitchenDish, sameKitchenLine,
} = await import("../shared/kitchenAdults");
const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const { BUILT_IN_BEO_PARSING_ADVICE, BeoFillSchema, REQUIRED_FIELDS_HEADING, readModelAnswer, requiredFieldsBlock } = await import("../server/lib/aiFill");
const { BEO_FILL_WITH_CATALOGUE_SHAPE, beoCatalogueSystemBlock, emptyCatalogue, resolveCatalogueAnswer } = await import("../server/lib/beoCatalogueFill");
const { beoPdfHtml } = await import("../server/pdf");
const { pool: appDbPool } = await import("../server/db");
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type BeoAiApproveBody = import("../shared/beoAiFill").BeoAiApproveBody;

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; productCode?: string; groupId?: string };
const line = (id: string, itemName: string, quantity = 1, over: Partial<Line> = {}): Line => ({ id, itemName, quantity, notes: "", included: true, price: 0, ...over });

// ─── The shared rules, on their own ──────────────────────────────────────────

await check("the stored shape's reading: saved on, or lines that are not the kids' list; empty or equal is off", () => {
  const kids = [line("k1", "Nuggets", 8), line("k2", "Fries", 2, { notes: "no salt" })];
  assert.equal(adultsDifferOf({ kids, adults: [], adultsDiffer: true }), true, "saved on stands");
  assert.equal(adultsDifferOf({ kids, adults: [] }), false, "no adults' list: the kids'");
  assert.equal(adultsDifferOf({ kids, adults: kids.map((l) => ({ ...l, id: `c_${l.id}` })) }), false, "an equal list saved before: the kids'");
  assert.equal(adultsDifferOf({ kids, adults: [line("a1", "Steak", 4)] }), true, "two different lists saved before: the adults' own");
  assert.equal(adultsDifferOf({ kids, adults: [line("a1", "nuggets ", 8), line("a2", "Fries", 2, { notes: "no salt" })] }), false, "case and spacing aside");
  assert.equal(adultsDifferOf({ kids, adults: [line("a1", "Nuggets", 2), line("a2", "Fries", 2, { notes: "no salt" })] }), true, "another count differs");
  assert.equal(adultsDifferOf({ kids, adults: [line("a1", "Steak")], adultsDiffer: false }), true, "saved off but holding another list (a New item on the day): their own");
  assert.equal(adultsDifferOf(null), false);
  assert.equal(adultsDifferOf({ kids: [], adults: [line("a1", "Steak")] }), true, "an adults-only list of before");
  assert.equal(kitchenListsEqual(kids, [...kids, line("k3", "Cake")]), false);
  assert.deepEqual(adultsListOf({ kids, adults: [] }).map((l) => l.itemName), ["Nuggets", "Fries"]);
  assert.deepEqual(adultsListOf({ kids, adults: [line("a1", "Steak")], adultsDiffer: true }).map((l) => l.itemName), ["Steak"]);
  // The same dish for the till (name, count, code) is not the same line when its note differs.
  assert.equal(sameKitchenDish(line("k", "Cake", 1, { productCode: "PARTY-X" }), line("a", "cake ", 1, { productCode: "PARTY-X", notes: "no candles" })), true);
  assert.equal(sameKitchenLine(line("k", "Cake", 1, { productCode: "PARTY-X" }), line("a", "cake ", 1, { productCode: "PARTY-X", notes: "no candles" })), false);
  assert.equal(sameKitchenDish(line("k", "Cake", 1), line("a", "Cake", 2)), false, "another count is another dish");
  assert.equal(sameKitchenDish(line("k", "Cake", 1, { productCode: "PARTY-X" }), line("a", "Cake", 1, { productCode: "PARTY-Y" })), false, "another code is another dish");
  assert.equal(adultsDifferOf({ kids, adults: [line("a1", "Nuggets", 8), line("a2", "Fries", 2)] }), true, "a note cleared for the adults is a change of theirs");
  assert.deepEqual(adultsCopiesOf([line("set_x", "A"), { itemName: "B" }]).map((l) => l.id), ["set_x_adults", "line_adults"]);
});

await check("the adults' changes on one list: kids only, two counts, a note of their own, adults only; none with the switch off", () => {
  const kids = [line("k1", "Nuggets", 8), line("k2", "Fries", 2), line("k3", "Juice", 10), line("k4", "Cake", 1)];
  const adults = [line("a1", "Fries", 2), line("a2", "Juice", 4), line("a3", "Pasta", 3), line("a4", "Cake", 1, { notes: "no candles" })];
  const marks = kitchenAdultsMarks(kids, adults, true);
  assert.deepEqual(marks.marks, [KIDS_ONLY_MARK, null, adultsCountMark(10, 4), "adults: no candles"]);
  assert.equal(adultsNoteMark(" no candles "), "adults: no candles");
  assert.equal(adultsNoteMark(""), ADULTS_NO_NOTE_MARK);
  assert.equal(ADULTS_NO_NOTE_MARK, "adults: no note");
  // A note cleared for the adults is marked too, never dropped.
  assert.deepEqual(kitchenAdultsMarks([line("k1", "Pasta", 10, { notes: "no cheese" })], [line("a1", "Pasta", 10)], true).marks, [ADULTS_NO_NOTE_MARK]);
  assert.equal(adultsCountMark(10, 4), "kids 10 · adults 4");
  assert.deepEqual(marks.adultsOnly.map((l) => l.itemName), ["Pasta"]);
  assert.equal(ADULTS_ONLY_MARK, "adults only");
  assert.equal(ADULTS_SAME_AS_KIDS, "Same as the kids' menu");
  const off = kitchenAdultsMarks(kids, adults, false);
  assert.deepEqual(off.marks, [null, null, null, null]);
  assert.deepEqual(off.adultsOnly, []);
  // Two kids' lines of one name take two adults' lines of that name, in order.
  const twice = kitchenAdultsMarks([line("k1", "Juice", 2), line("k2", "Juice", 3)], [line("a1", "Juice", 2)], true);
  assert.deepEqual(twice.marks, [null, KIDS_ONLY_MARK]);
});

// ─── The AI fill: the prompts and a stub model ───────────────────────────────

await check("both prompts tell the model the adults eat the kids' menu unless the message says otherwise; every line key is still required", () => {
  assert.match(BUILT_IN_BEO_PARSING_ADVICE, /The adults eat what the kids eat unless the message says otherwise/);
  assert.match(BUILT_IN_BEO_PARSING_ADVICE, /adultsMenu is everything the adults eat — the dishes they share with the kids included/);
  assert.match(BUILT_IN_BEO_PARSING_ADVICE, /"nuggets for everyone, and a cheese platter for the adults" gives adultsMenu the nuggets and the cheese platter/);
  const block = beoCatalogueSystemBlock(emptyCatalogue(), { conversation: true });
  assert.match(block, /The adults eat what the kids eat unless the conversation says otherwise/);
  assert.match(block, /the "adults" lines are everything the adults eat — a dish they share with the kids given again as an "adults" line/);
  const required = requiredFieldsBlock(BEO_FILL_WITH_CATALOGUE_SHAPE);
  assert.ok(required.startsWith(`\n\n${REQUIRED_FIELDS_HEADING}\n`));
  for (const key of ["kitchenPlan.kidsMenu[].itemName", "kitchenPlan.adultsMenu[].itemName", "kitchenPlan.adultsMenu[].quantity", "catalogue.menuLines[].menu"]) {
    assert.ok(required.includes(`\n- ${key}: `), `the block names ${key}`);
  }
  assert.match(required, /\n- catalogue\.menuLines\[\]\.menu: one of "kids", "adults", "bar": "kids" for every dish the party eats, "adults" for each dish the adults eat when the conversation says their food differs from the kids', "bar" for a drink\n/);
});

await check("a stub model's one list leaves the form with no adults' list; its adults' own dish is carried; a catalogue dish with no list is the kids'", () => {
  const same = readModelAnswer(JSON.stringify({ kitchenPlan: { kidsMenu: [{ itemName: "Nuggets", quantity: 8 }, { itemName: "Fries", quantity: 2 }] } }), BeoFillSchema);
  assert.ok(same.ok);
  assert.deepEqual(same.value.kitchenPlan?.kidsMenu?.map((l) => l.itemName), ["Nuggets", "Fries"]);
  assert.equal(same.value.kitchenPlan?.adultsMenu, undefined, "no adults' list: the editor opens with the switch off");
  const differ = readModelAnswer(JSON.stringify({ kitchenPlan: { kidsMenu: [{ itemName: "Nuggets", quantity: 8 }], adultsMenu: [{ itemName: "Pasta", quantity: 4 }] } }), BeoFillSchema);
  assert.ok(differ.ok);
  assert.deepEqual(differ.value.kitchenPlan?.adultsMenu?.map((l) => [l.itemName, l.quantity]), [["Pasta", 4]], "the adults' own dish: the editor turns the switch on");
  const proposal = resolveCatalogueAnswer(
    { menuLines: [{ productCode: null, itemName: "Fruit skewers", quantity: 2, notInMenu: true, line: 1 }, { productCode: null, itemName: "Pasta", menu: "adults", quantity: 4, notInMenu: true, line: 1 }] },
    emptyCatalogue(),
    [],
    { source: "team", at: null, line: null },
  );
  assert.deepEqual(proposal.menuLines.map((l) => [l.menu, l.itemName]), [["kids", "Fruit skewers"], ["adults", "Pasta"]]);
});

// ─── Rows ─────────────────────────────────────────────────────────────────────

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const coreBranch = randomUUID();
const manager = randomUUID();
const setMenuId = randomUUID();
const PIZZA = "item_zz829_pizza";
const FRIES = "item_zz829_fries";
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" }, qty: 3 },
  { id: FRIES, type: "always_included", label: "French fries", productCode: "CF-11", qty: 2 },
];
const ev = {
  plain: randomUUID(), differ: randomUUID(), before: randomUUID(), setMenu: randomUUID(), approve: randomUUID(), approveKids: randomUUID(),
  beside: randomUUID(), approveSet: randomUUID(), submit: randomUUID(), submitOff: randomUUID(),
};

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  if (req.get("x-test-as") !== "manager") return res.status(401).json({ message: "Not signed in" });
  (req as any).isAuthenticated = () => true;
  (req as any).user = { id: manager, tenantId: tenant, role: "manager" };
  (req as any).userWithAccess = { id: manager, tenantId: tenant, isActive: true, role: "manager", hasAllBranchesAccess: false, allowedBranchIds: [park] };
  next();
}

/** The stub model: the message's words say whether the adults eat something different. */
const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    const adultsDiffer = call.user.includes("ADULTS-829");
    return JSON.stringify({
      summary: "ZZ 829",
      event: { childName: "Mali", numChildren: 10, numAdults: 4 },
      kitchenPlan: {
        kidsMenu: [{ itemName: "Nuggets", quantity: 8 }, { itemName: "Fries", quantity: 2 }],
        ...(adultsDiffer ? { adultsMenu: [{ itemName: "Pasta", quantity: 4 }] } : {}),
      },
    });
  },
};

const servers: Server[] = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
registerAIRoutes(app, fakeAuth, { ai, inboxConfirmation: async () => ({ ok: false, reason: "inbox_unreachable" }) });
registerBeoRoutes(app);
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function send(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-as": "manager" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const kitchenOf = async (eventId: string) =>
  (await q<{ menus: Record<string, any>; simplified_menus: Record<string, any> | null }>("select menus, simplified_menus from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null;
const viewOf = async (eventId: string) =>
  (await q<{ set_menu: Array<Record<string, unknown>> }>("select set_menu from otoapp_v.event_packages where event_id = $1", [eventId]))[0]?.set_menu ?? null;
const saveKitchen = (eventId: string, menus: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  send("PUT", `/api/events/${eventId}/beo`, {
    kitchenPlan: { foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null, menus, serviceSchedule: [], ...over },
  });

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 829 ${run}`, `zz-829-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST 829 park', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, coreBranch]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 829', 'manager', true, false)", [manager, `zz-829-${run}@example.com`]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'ZZ TEST 829 set menu', $3)", [setMenuId, tenant, JSON.stringify(setMenuItems)]);
  for (const [key, id] of Object.entries(ev)) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
       values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming')`,
      [id, tenant, park, `ZZ TEST 829 ${key} ${run}`],
    );
    await q("insert into beo_package_snapshots (id, event_id, package_name, base_price) values ($1, $2, 'ZZ TEST package', 1690000)", [randomUUID(), id]);
  }

  const KIDS = [line("k1", "Nuggets", 8), line("k2", "Fries", 2, { notes: "no salt" }), line("k3", "ZZ unicorn cake", 1, { productCode: "PARTY-ZZ829A" })];

  await check("saved with the switch off: no adults' list and adultsDiffer false; the read gives both back", async () => {
    const saved = await saveKitchen(ev.plain, { kids: KIDS, adults: [], adultsDiffer: false, kidsFoodTime: "14:00", adultsFoodTime: "" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const plan = await kitchenOf(ev.plain);
    assert.deepEqual(plan?.menus.adults, []);
    assert.equal(plan?.menus.adultsDiffer, false);
    assert.equal(plan?.menus.kidsFoodTime, "14:00");
    assert.deepEqual(plan?.simplified_menus, { kids: KIDS, adults: [] });
    const read = await send("GET", `/api/events/${ev.plain}/beo`);
    assert.equal(read.status, 200);
    assert.equal(read.body.kitchenPlan.menus.adultsDiffer, false);
    assert.deepEqual(read.body.kitchenPlan.menus.adults, []);
  });

  const ADULTS = [line("a1", "Pasta", 7), line("a2", "Fries", 2, { notes: "no salt" }), line("a3", "ZZ unicorn cake", 1, { productCode: "PARTY-ZZ829A" }), line("a4", "Steak", 4, { productCode: "PARTY-ZZ829B" })];

  await check("saved with the switch on: the adults' own list and adultsDiffer true; an editor from before the switch gets the key its lists say; the day-of view's write keeps it", async () => {
    const saved = await saveKitchen(ev.differ, { kids: KIDS, adults: ADULTS, adultsDiffer: true, kidsFoodTime: "14:00", adultsFoodTime: "15:00" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    let plan = await kitchenOf(ev.differ);
    assert.equal(plan?.menus.adultsDiffer, true);
    assert.deepEqual(plan?.menus.adults, ADULTS);
    assert.deepEqual(plan?.menus.kids, KIDS);
    // The day-of view writes the lists through the kitchen plan's own route, spreading what the plan holds.
    const dayOf = await send("PUT", `/api/events/${ev.differ}/beo/kitchen-plan`, { menus: { ...plan!.menus, kids: [...KIDS, line("k4", "Fruit skewers", 1)] } });
    assert.equal(dayOf.status, 200, JSON.stringify(dayOf.body));
    plan = await kitchenOf(ev.differ);
    assert.equal(plan?.menus.adultsDiffer, true, "the switch survives the day-of view's write");
    assert.equal((plan?.menus.kids as Line[]).length, 4);
    // An editor from before the switch (no key sent) with two different lists: the plan records
    // the switch its lists say, so the till reads it as the editor opens it.
    const before = await saveKitchen(ev.before, { kids: KIDS, adults: [line("a1", "Steak", 4, { productCode: "PARTY-ZZ829B" })], kidsFoodTime: "", adultsFoodTime: "" });
    assert.equal(before.status, 200);
    plan = await kitchenOf(ev.before);
    assert.equal(plan!.menus.adultsDiffer, true, "the key its lists say, for an editor that sent none");
    assert.equal(adultsDifferOf(plan!.menus), true, "and it opens with the switch on");
    const sameLists = await saveKitchen(ev.before, { kids: KIDS, adults: KIDS.map((l) => ({ ...l, id: `c_${l.id}` })), kidsFoodTime: "", adultsFoodTime: "" });
    assert.equal(sameLists.status, 200);
    assert.equal((await kitchenOf(ev.before))!.menus.adultsDiffer, false, "a duplicate list sent with no key is the kids' menu");
    // Back to the kids' menu: the lists save as the switch says.
    const off = await saveKitchen(ev.differ, { kids: plan!.menus.kids, adults: [], adultsDiffer: false, kidsFoodTime: "14:00", adultsFoodTime: "" });
    assert.equal(off.status, 200);
    assert.equal((await kitchenOf(ev.differ))?.menus.adultsDiffer, false);
    const on = await saveKitchen(ev.differ, { kids: KIDS, adults: ADULTS, adultsDiffer: true, kidsFoodTime: "14:00", adultsFoodTime: "15:00" });
    assert.equal(on.status, 200);
  });

  await check("the till's plan view: a party saved before the switch and never written since reads as 0047 read it; one written since reads as the editor opens it", async () => {
    // A party of before (no key, never written since) with two different lists: exactly 0047 —
    // kids before adults, coded lines only, no marks (nothing moves until it is written again).
    const twoLists = { kids: KIDS, adults: [line("a1", "Steak", 4, { productCode: "PARTY-ZZ829B" })] };
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.before, JSON.stringify(twoLists)]);
    assert.deepEqual(await viewOf(ev.before), [
      { product_code: "PARTY-ZZ829A", name: "ZZ unicorn cake", qty: 1, choice_group: null, chosen_option: null, note: null },
      { product_code: "PARTY-ZZ829B", name: "Steak", qty: 4, choice_group: null, chosen_option: null, note: null },
    ], "kids before adults, coded lines only, no audience");
    assert.deepEqual(await viewOf(ev.plain), [
      { product_code: "PARTY-ZZ829A", name: "ZZ unicorn cake", qty: 1, choice_group: null, chosen_option: null, note: null },
    ], "the switch off: the kids' coded lines alone, no marks");
    // A party of before whose adults' list copies a coded kids' line: twice, as before (nothing moves until it is written again).
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.before, JSON.stringify({ kids: KIDS, adults: KIDS.map((l) => ({ ...l, id: `c_${l.id}` })) })]);
    assert.equal((await viewOf(ev.before))!.length, 2, "the copied coded line twice, exactly as 0047");
    // The two-list party of before written once more by the day-of view's route without the key
    // (what the plan holds, spread): the key its lists say is recorded, and the till now reads it
    // as the editor opens it — the same lines and charges, the adults' changes marked.
    const dayOf = await send("PUT", `/api/events/${ev.before}/beo/kitchen-plan`, { menus: twoLists });
    assert.equal(dayOf.status, 200, JSON.stringify(dayOf.body));
    assert.equal((await kitchenOf(ev.before))!.menus.adultsDiffer, true);
    assert.deepEqual(await viewOf(ev.before), [
      { product_code: "PARTY-ZZ829A", name: "ZZ unicorn cake", qty: 1, choice_group: null, chosen_option: null, note: null, audience: "kids" },
      { product_code: "PARTY-ZZ829B", name: "Steak", qty: 4, choice_group: null, chosen_option: null, note: null, audience: "adults" },
    ]);
    // The same copy with one note changed for the adults, written the same way: a change of theirs,
    // so the switch is recorded on; the dish is one line with the adults' note beside it, charged once.
    const noted = await send("PUT", `/api/events/${ev.before}/beo/kitchen-plan`, { menus: {
      kids: KIDS,
      adults: KIDS.map((l) => ({ ...l, id: `c_${l.id}`, ...(l.productCode ? { notes: "no candles" } : {}) })),
    } });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    assert.deepEqual(await viewOf(ev.before), [
      { product_code: "PARTY-ZZ829A", name: "ZZ unicorn cake", qty: 1, choice_group: null, chosen_option: null, note: null, adults_note: "no candles" },
    ]);
  });

  await check("with the switch on: an unchanged copy reaches the till once, a line the adults do not get is marked kids, their own lines marked adults", async () => {
    const rows = await viewOf(ev.differ);
    assert.deepEqual(rows, [
      // The kids' coded line: the adults' list holds a line of its name, so no mark; its unchanged copy is not emitted.
      { product_code: "PARTY-ZZ829A", name: "ZZ unicorn cake", qty: 1, choice_group: null, chosen_option: null, note: null },
      // The adults' own: a dish of a new name (no code), and a coded one of theirs.
      { product_code: null, name: "Pasta", qty: 7, choice_group: null, chosen_option: null, note: null, audience: "adults" },
      { product_code: "PARTY-ZZ829B", name: "Steak", qty: 4, choice_group: null, chosen_option: null, note: null, audience: "adults" },
    ]);
    // A coded kids' line the adults' list drops, and one in another count.
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.differ, JSON.stringify({
      adultsDiffer: true,
      kids: KIDS,
      adults: [line("a1", "Nuggets", 2), line("a2", "Fries", 2, { notes: "no salt" })],
    })]);
    assert.deepEqual(await viewOf(ev.differ), [
      // The kids' nuggets have no code and never reached the till; the adults get them in another
      // count, so the line is emitted (uncharged) for the slip to print "kids 8 · adults 2" beside it.
      { product_code: null, name: "Nuggets", qty: 8, choice_group: null, chosen_option: null, note: null },
      { product_code: "PARTY-ZZ829A", name: "ZZ unicorn cake", qty: 1, choice_group: null, chosen_option: null, note: null, audience: "kids" },
      { product_code: null, name: "Nuggets", qty: 2, choice_group: null, chosen_option: null, note: null, audience: "adults" },
    ], "the cake is the kids' only; the nuggets in the adults' own count beside the kids'; the fries an unchanged copy");
    // The same lists with the switch off: exactly the kids' coded line, no marks.
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.differ, JSON.stringify({ adultsDiffer: false, kids: KIDS, adults: [] })]);
    assert.deepEqual(await viewOf(ev.differ), [
      { product_code: "PARTY-ZZ829A", name: "ZZ unicorn cake", qty: 1, choice_group: null, chosen_option: null, note: null },
    ]);
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.differ, JSON.stringify({ adultsDiffer: true, kids: KIDS, adults: ADULTS, kidsFoodTime: "14:00", adultsFoodTime: "15:00" })]);
  });

  await check("a coded line copied for the adults with only its note changed, or cleared, reaches the till once with the adults' note beside it", async () => {
    const codes = (rows: Array<Record<string, unknown>>, code: string) =>
      rows.filter((r) => r.product_code === code).reduce((sum, r) => sum + ((r.qty as number | null) ?? 1), 0);
    // The feature's happy path: the switch on, a note for the adults on the one cake.
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.differ, JSON.stringify({
      adultsDiffer: true,
      kids: [line("k1", "ZZ cake", 1, { productCode: "PARTY-ZZ829A" })],
      adults: [line("a1", "ZZ cake", 1, { productCode: "PARTY-ZZ829A", notes: "no candles" })],
    })]);
    let rows = (await viewOf(ev.differ))!;
    assert.deepEqual(rows, [
      { product_code: "PARTY-ZZ829A", name: "ZZ cake", qty: 1, choice_group: null, chosen_option: null, note: null, adults_note: "no candles" },
    ], "one line, the adults' note on it, no second coded line");
    assert.equal(codes(rows, "PARTY-ZZ829A"), 1, "the till charges the cake once");
    // The reverse: the kids' note cleared for the adults is a difference the slip must say.
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.differ, JSON.stringify({
      adultsDiffer: true,
      kids: [line("k1", "Pasta", 10, { productCode: "PARTY-ZZ829B", notes: "no cheese" })],
      adults: [line("a1", "Pasta", 10, { productCode: "PARTY-ZZ829B" })],
    })]);
    rows = (await viewOf(ev.differ))!;
    assert.deepEqual(rows, [
      { product_code: "PARTY-ZZ829B", name: "Pasta", qty: 10, choice_group: null, chosen_option: null, note: "no cheese", adults_note: "" },
    ], "the kids' note stays, the cleared adults' note is carried as an empty one");
    assert.equal(codes(rows, "PARTY-ZZ829B"), 10, "charged once, not twice");
    // An uncoded kids' line the adults get in another count: both lines, neither charged, so the
    // slip folds them into "kids 2 · adults 4" instead of calling the skewers the adults' alone.
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.differ, JSON.stringify({
      adultsDiffer: true,
      kids: [line("k1", "Fruit skewers", 2), line("k2", "Juice", 10)],
      adults: [line("a1", "Fruit skewers", 4), line("a2", "Juice", 10)],
    })]);
    assert.deepEqual(await viewOf(ev.differ), [
      { product_code: null, name: "Fruit skewers", qty: 2, choice_group: null, chosen_option: null, note: null },
      { product_code: null, name: "Fruit skewers", qty: 4, choice_group: null, chosen_option: null, note: null, audience: "adults" },
    ], "the juice, an unchanged copy with no code, is nobody's line on the till");
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.differ, JSON.stringify({ adultsDiffer: true, kids: KIDS, adults: ADULTS, kidsFoodTime: "14:00", adultsFoodTime: "15:00" })]);
  });

  await check("a set-menu line the kids' list holds and the adults' drops is marked kids; one never written into the kids' list is left alone", async () => {
    const resolved = [
      line("set_pizza", "Margherita", 3, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA }),
      line("set_fries", "French fries", 2, { source: "set_menu", groupId: FRIES }),
    ];
    await q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted, selections) values ($1, $2, $3, $4, true, $5)", [
      randomUUID(), ev.setMenu, setMenuId, `zz-829-${run}`, JSON.stringify([{ groupId: PIZZA, chosenOptions: ["Margherita"] }]),
    ]);
    await q("insert into beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus) values ($1, $2, true, $3, $4)", [
      randomUUID(), ev.setMenu, setMenuId,
      JSON.stringify({ adultsDiffer: true, kids: resolved, adults: [line("a1", "French fries", 2), line("a2", "Pasta", 4)] }),
    ]);
    assert.deepEqual(await viewOf(ev.setMenu), [
      { product_code: "CF-24", name: "Pizza", qty: 3, choice_group: "Pizza", chosen_option: "Margherita", note: null, audience: "kids" },
      { product_code: "CF-11", name: "French fries", qty: 2, choice_group: null, chosen_option: null, note: null },
      { product_code: null, name: "Pasta", qty: 4, choice_group: null, chosen_option: null, note: null, audience: "adults" },
    ]);
    // The kids' list without the set menu's lines (the parent has not chosen through the link yet): the template's lines are not the adults' doing.
    await q("update beo_kitchen_plans set menus = $2 where event_id = $1", [ev.setMenu, JSON.stringify({ adultsDiffer: true, kids: [line("k1", "Cake", 1)], adults: [line("a1", "Cake", 1), line("a2", "Pasta", 4)] })]);
    assert.deepEqual((await viewOf(ev.setMenu))!.map((r) => [r.name, r.audience ?? null]), [["Pizza", null], ["French fries", null], ["Pasta", "adults"]]);
  });

  await check("the set menu stays in step for the adults' own list: the parent's submit after the switch, and a Save with a stale submission", async () => {
    const stale = [
      line("set_pizza", "Margherita", 3, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA }),
      line("set_fries", "French fries", 2, { source: "set_menu", groupId: FRIES }),
    ];
    const skewers = line("k1", "Fruit skewers", 2, { source: "additional" });
    // The switch turned on (the adults' list a copy of the kids', the stale pizza included) before
    // the family chose through the link; then the family chooses Hawaiian.
    const token = `zz-829-submit-${run}`;
    await q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted, selections) values ($1, $2, $3, $4, false, null)", [randomUUID(), ev.submit, setMenuId, token]);
    await q("insert into beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus, simplified_menus) values ($1, $2, true, $3, $4, $4)", [
      randomUUID(), ev.submit, setMenuId,
      JSON.stringify({ adultsDiffer: true, kids: [...stale, skewers], adults: [...stale.map((l) => ({ ...l, id: `c_${l.id}` })), line("a3", "Fruit skewers", 4, { source: "additional" })] }),
    ]);
    const submitted = await fetch(`${base}/api/beo/set-menu-selections/public/${token}/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selections: [{ groupId: PIZZA, chosenOptions: ["Hawaiian"] }] }),
    });
    assert.equal(submitted.status, 200, await submitted.text());
    let plan = await kitchenOf(ev.submit);
    assert.deepEqual((plan!.menus.kids as Line[]).map((l) => [l.itemName, l.source ?? null]), [["Hawaiian", "set_menu"], ["French fries", "set_menu"], ["Fruit skewers", "additional"]]);
    assert.deepEqual((plan!.menus.adults as Line[]).map((l) => [l.id, l.itemName, l.quantity]), [
      [`set_${PIZZA}_Hawaiian_adults`, "Hawaiian", 3], [`set_${FRIES}_adults`, "French fries", 2], ["a3", "Fruit skewers", 4],
    ], "the adults' set menu is the family's choice as it now stands; their own skewers stay");
    assert.equal(plan!.menus.adultsDiffer, true);
    assert.deepEqual((plan!.simplified_menus!.adults as Line[]).map((l) => l.itemName), ["Hawaiian", "French fries", "Fruit skewers"]);
    assert.deepEqual((await viewOf(ev.submit))!.map((r) => [r.chosen_option ?? r.name, r.qty, r.audience ?? null]), [
      ["Hawaiian", 3, null], ["French fries", 2, null], ["Fruit skewers", 2, null], ["Fruit skewers", 4, "adults"],
    ], "no set-menu line is the kids' only; the skewers in both counts");
    // Staff who turned the switch on in the open editor before the family chose now Save with the
    // submission they knew (none): the family's lines win for the kids, and for the adults too.
    await q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted, submitted_at, selections) values ($1, $2, $3, $4, true, now(), $5)", [
      randomUUID(), ev.submitOff, setMenuId, `zz-829-off-${run}`, JSON.stringify([{ groupId: PIZZA, chosenOptions: ["Hawaiian"] }]),
    ]);
    const chosen = [
      line(`set_${PIZZA}_Hawaiian`, "Hawaiian", 3, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA }),
      line(`set_${FRIES}`, "French fries", 2, { source: "set_menu", groupId: FRIES }),
    ];
    await q("insert into beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus, simplified_menus) values ($1, $2, true, $3, $4, $4)", [
      randomUUID(), ev.submitOff, setMenuId, JSON.stringify({ adultsDiffer: false, kids: [...chosen, skewers], adults: [] }),
    ]);
    const saved = await saveKitchen(ev.submitOff, {
      adultsDiffer: true, kids: [...stale, skewers], adults: [...stale.map((l) => ({ ...l, id: `c_${l.id}` })), line("a3", "Fruit skewers", 4, { source: "additional" })], kidsFoodTime: "", adultsFoodTime: "",
    }, { setMenuEnabled: true, setMenuTemplateId: setMenuId, setMenuSelectionSubmittedAt: null });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    plan = await kitchenOf(ev.submitOff);
    assert.deepEqual((plan!.menus.kids as Line[]).map((l) => l.itemName), ["Hawaiian", "French fries", "Fruit skewers"]);
    assert.deepEqual((plan!.menus.adults as Line[]).map((l) => [l.id, l.itemName]), [[`set_${PIZZA}_Hawaiian_adults`, "Hawaiian"], [`set_${FRIES}_adults`, "French fries"], ["a3", "Fruit skewers"]], "the family's lines for the adults, not the staff's stale copies");
    assert.equal(plan!.menus.adultsDiffer, true);
  });

  await check("Approve and create: an adults' line turns the switch on; kids' lines alone leave it as the BEO holds it, recorded", async () => {
    const body = (menuLines: BeoAiApproveBody["menuLines"]): BeoAiApproveBody => ({
      conversationId: null, messageId: null, package: null, setMenu: null, menuLines, entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
    });
    const kidsOnly = await send("POST", `/api/events/${ev.approveKids}/beo/ai-fill/approve`, body([{ menu: "kids", itemName: "Fruit skewers", quantity: 2, productCode: null, notes: null }]));
    assert.equal(kidsOnly.status, 200, JSON.stringify(kidsOnly.body));
    let plan = await kitchenOf(ev.approveKids);
    assert.equal(plan!.menus.adultsDiffer, false, "no adults' line: the switch stays off, as the BEO holds it");
    assert.deepEqual((plan!.menus.kids as Line[]).map((l) => l.itemName), ["Fruit skewers"]);
    assert.deepEqual(plan!.menus.adults, []);
    const withAdults = await send("POST", `/api/events/${ev.approve}/beo/ai-fill/approve`, body([
      { menu: "kids", itemName: "Fruit skewers", quantity: 2, productCode: null, notes: null },
      { menu: "adults", itemName: "Pasta", quantity: 4, productCode: null, notes: null },
    ]));
    assert.equal(withAdults.status, 200, JSON.stringify(withAdults.body));
    plan = await kitchenOf(ev.approve);
    assert.equal(plan!.menus.adultsDiffer, true, "the chat said the adults eat something different");
    assert.deepEqual((plan!.menus.adults as Line[]).map((l) => l.itemName), ["Pasta"]);
    assert.deepEqual((await viewOf(ev.approve))!.map((r) => [r.name, r.audience ?? null]), [["Pasta", "adults"]], "and the till's plan marks it");
    // "Skewers for everyone, and pasta for the adults": the adults' list is everything they eat, so
    // the shared skewers are nobody's only and the pasta theirs alone.
    const beside = await send("POST", `/api/events/${ev.beside}/beo/ai-fill/approve`, body([
      { menu: "kids", itemName: "Fruit skewers", quantity: 2, productCode: null, notes: null },
      { menu: "adults", itemName: "Fruit skewers", quantity: 2, productCode: null, notes: null },
      { menu: "adults", itemName: "Pasta", quantity: 4, productCode: null, notes: null },
    ]));
    assert.equal(beside.status, 200, JSON.stringify(beside.body));
    plan = await kitchenOf(ev.beside);
    assert.equal(plan!.menus.adultsDiffer, true);
    assert.deepEqual((plan!.menus.adults as Line[]).map((l) => l.itemName), ["Fruit skewers", "Pasta"]);
    assert.deepEqual(kitchenAdultsMarks(plan!.menus.kids, plan!.menus.adults, true).marks, [null], "no kids-only mark on the shared skewers");
    assert.deepEqual((await viewOf(ev.beside))!.map((r) => [r.name, r.audience ?? null]), [["Pasta", "adults"]]);
    // An approval with a set menu and an adults' line: the adults' list takes copies of the set menu's lines.
    const withSet = await send("POST", `/api/events/${ev.approveSet}/beo/ai-fill/approve`, {
      ...body([{ menu: "adults", itemName: "Pasta", quantity: 4, productCode: null, notes: null }]),
      setMenu: { templateId: setMenuId, choices: [{ itemId: PIZZA, options: ["Margherita"] }] },
    });
    assert.equal(withSet.status, 200, JSON.stringify(withSet.body));
    plan = await kitchenOf(ev.approveSet);
    assert.deepEqual((plan!.menus.kids as Line[]).map((l) => [l.itemName, l.source]), [["Margherita", "set_menu"], ["French fries", "set_menu"]]);
    assert.deepEqual((plan!.menus.adults as Line[]).map((l) => [l.id, l.itemName, l.source]), [
      [`set_${PIZZA}_Margherita_adults`, "Margherita", "set_menu"], [`set_${FRIES}_adults`, "French fries", "set_menu"], [(plan!.menus.adults as Line[])[2]!.id, "Pasta", "additional"],
    ]);
    assert.deepEqual((await viewOf(ev.approveSet))!.map((r) => [r.chosen_option ?? r.name, r.audience ?? null]), [["Margherita", null], ["French fries", null], ["Pasta", "adults"]], "the set menu is not the kids' only");
  });

  await check("AI Fill on a pasted message: the prompt carries the rule; one list when the message names no food of the adults' own, their dish when it does", async () => {
    const same = await send("POST", "/api/ai/parse-beo", { text: "Confirmed: nuggets and fries for everyone. SAME-829", existingData: {} });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.match(modelCalls.at(-1)!.system, /The adults eat what the kids eat unless the message says otherwise/);
    assert.deepEqual(same.body.kitchenPlan.kidsMenu.map((l: Line) => l.itemName), ["Nuggets", "Fries"]);
    assert.equal(same.body.kitchenPlan.adultsMenu, undefined);
    const differ = await send("POST", "/api/ai/parse-beo", { text: "Confirmed: nuggets for the kids, pasta for the adults. ADULTS-829", existingData: {} });
    assert.equal(differ.status, 200, JSON.stringify(differ.body));
    assert.deepEqual(differ.body.kitchenPlan.adultsMenu.map((l: Line) => [l.itemName, l.quantity]), [["Pasta", 4]]);
  });

  await check("the BEO PDF prints one food list: the adults' line with the switch off; their changes marked and their own dishes after with it on", async () => {
    const pdf = (menus: Record<string, unknown>, setMenuEnabled = false) =>
      beoPdfHtml({ eventTitle: "ZZ TEST 829", eventDate: "2099-03-14", startTime: "13:00", status: "upcoming", kitchenPlan: { required: true, menus: menus as any, setMenuEnabled } });
    const off = await pdf({ kids: KIDS, adults: [], adultsDiffer: false, kidsFoodTime: "14:00" });
    assert.ok(off.includes("Kids Menu"), "the kids' menu is the main selection");
    assert.ok(off.includes("Adults: same as the kids' menu"), "one line says the adults eat it");
    assert.ok(!off.includes("Adults Menu"), "no second list");
    assert.ok(!off.includes(KIDS_ONLY_MARK) && !off.includes(ADULTS_ONLY_MARK));
    const on = await pdf({ kids: KIDS, adults: [line("a1", "Nuggets", 2), line("a2", "Fries", 2, { notes: "no salt" }), line("a3", "Pasta", 4)], adultsDiffer: true, kidsFoodTime: "14:00", adultsFoodTime: "15:00" });
    assert.ok(on.includes("Adults: different for adults"), "the one line says their changes are marked");
    assert.ok(on.includes("&mdash; Service: 15:00"), "the adults' service time rides on it");
    assert.ok(!on.includes("Adults Menu"), "still no second list");
    assert.ok(on.includes(`Nuggets <span class="item-note" style="color:#92400e;font-weight:600;">— ${adultsCountMark(8, 2)}</span>`), "the two counts beside the nuggets");
    assert.ok(on.includes(`ZZ unicorn cake <span class="item-note" style="color:#92400e;font-weight:600;">— ${KIDS_ONLY_MARK}</span>`), "the cake the adults do not get");
    assert.ok(on.includes(`Pasta <span class="item-note" style="color:#92400e;font-weight:600;">— ${ADULTS_ONLY_MARK}</span>`), "the adults' own dish, marked");
    assert.equal(on.split("Fries").length, 2, "the fries once, unmarked");
    // A note cleared for the adults is marked, never dropped.
    const cleared = await pdf({ kids: KIDS, adults: [line("a1", "Nuggets", 8), line("a2", "Fries", 2), line("a3", "ZZ unicorn cake", 1, { productCode: "PARTY-ZZ829A" })], adultsDiffer: true });
    assert.ok(cleared.includes(`Fries <span class="item-note">(no salt)</span> <span class="item-note" style="color:#92400e;font-weight:600;">— ${ADULTS_NO_NOTE_MARK}</span>`), "the kids' note stays, the adults' clearing marked");
    // A set-menu BEO: the marks ride on the set menu's own rows too.
    const set = await pdf({
      kids: [line("s1", "Margherita", 3, { source: "set_menu", notes: "(Pizza)" }), line("k2", "Fruit skewers", 2, { source: "additional" })],
      adults: [line("a1", "Fruit skewers", 2)],
      adultsDiffer: true,
    }, true);
    assert.ok(set.includes(`Margherita ((Pizza)) <span class="item-note" style="color:#92400e;font-weight:600;">— ${KIDS_ONLY_MARK}</span>`), "a set-menu row the adults do not get");
    assert.equal(set.split("Fruit skewers").length, 2, "the additional item the adults share, once and unmarked");
    // A BEO saved before the switch with two different lists: their list as saved, as the adults' changes.
    const before = await pdf({ kids: KIDS, adults: [line("a1", "Steak", 4)] });
    assert.ok(before.includes(`Steak <span class="item-note" style="color:#92400e;font-weight:600;">— ${ADULTS_ONLY_MARK}</span>`));
    assert.ok(before.includes(`Nuggets <span class="item-note" style="color:#92400e;font-weight:600;">— ${KIDS_ONLY_MARK}</span>`));
  });

  console.log(`kitchen-adults.check: ${checks} checks passed`);
} finally {
  for (const s of servers) s.close();
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}
process.exit(checks === 14 ? 0 : 1);
