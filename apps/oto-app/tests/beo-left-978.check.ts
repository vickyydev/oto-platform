// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the BEO's own routes on a bare server and
// needs a database whose otoapp schema the app's migrator has built (0050
// included). It reads the family's link page's day helper, so it runs with
// TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-978 — what the read-fix lane's staging proof and the reviews of the
// last two BEO lanes left (SCRUM-978, SCRUM-976, point 5 of SCRUM-966, points
// 4 and 7 of SCRUM-968), the routes', the PDF's and the fill's half (the
// screens' is tests/beo-left-978-ui.check.ts):
//   1. the BEO PDF prints the adults' own price: kids Margherita 3 at 400 and
//      adults 2 at 450 are two rows, each at its own price, as the editor and
//      the till have them; a line folds beside the kids' row only when that
//      row's price cell holds for it too; the kids' list is read from menus;
//   2. PARTY HOST and SETUP PLAN print only with something under them;
//   3. the editor's Save writes the cake count (the row, the BEO's read, the
//      till's plan view), and the till's kitchen edit keeps it;
//   4. PUT /api/events/:eventId/beo/kitchen-plan refuses a malformed body
//      with 400 and its reason, nothing written, and takes every body the
//      day-of view sends; the shape takes what the editor's Save, the AI
//      approval and the till's kitchen edit write;
//   5. a date or a clock time is never the chat's total; the fold's reason
//      quotes the words that say the adults eat the same; "ต่อ" is "per" only
//      before a count or a unit;
//   6. the adults' set line in another count keeps its till code, on the row
//      and in the till's plan view; one copied uncoded ("Different for
//      adults" in the editor or the day-of view) takes the set menu's code
//      once its count is the adults' own;
//   7. the family's link answers its park's time zone and prints the park's day;
//   8. with "Different for adults" already on, an adults' line that only
//      repeats the kids' set menu is no charged EXTRA; "3 more" stays one;
//      a repeat of a kids' extra is the kids' line on the adults' menu;
//   9. Fetch from chat compares a kids' choice with the kids' lines only.
//
// Every model answer here is scripted or none: no model key is used.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-left-978.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-left-978.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-978";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const beoRoutes = await import("../server/beo-routes");
const { applyTillKitchenEdit, planTillKitchenEdit } = await import("../server/lib/tillKitchenEdit");
const { approveBeoAiFill } = await import("../server/lib/beoAiApprove");
const { kitchenPlanPutBodySchema } = await import("../server/lib/kitchenPlanBody");
const { chatTotalOf, adultsSameAsKidsFolds, figureSaidEach, chatPriceIsTotal } = await import("../server/lib/beoCatalogueFill");
const { beoPdfHtml } = await import("../server/pdf");
const { BeoAiApproveBodySchema } = await import("../shared/beoAiFill");
const { adultsSetCopiesUncoded, adultsSetLinesTillCoded } = await import("../shared/kitchenAdults");
const { adultsFoldedAsKidsLineWords, adultsFoldedWords } = await import("../shared/beoAiFill");
const { approvalResultWords } = await import("../client/src/lib/beo-ai-review");
const { beoPrintFoldable } = await import("../shared/beoExtras");
const { fetchCatalogueChangesOf } = await import("../client/src/lib/beo-fetch-from-chat");
const { parkDayOf } = await import("../client/src/pages/public/menu-select");
const { db: appDb, pool: appDbPool } = await import("../server/db");
type PdfData = Parameters<typeof beoPdfHtml>[0];

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field below
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;

let checks = 0;
const failed: string[] = [];
/** Each check on its own: a failure is said and the next one still runs; the run fails at the end. */
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

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; productCode?: string; groupId?: string };
const line = (id: string, itemName: string, quantity = 1, over: Partial<Line> = {}): Line => ({ id, itemName, quantity, notes: "", included: false, price: 0, ...over });

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const manager = randomUUID();
const setMenuId = randomUUID();
const PIZZA = "item_zz978_pizza";
const RICE = "item_zz978_rice";
const FRIES = "item_zz978_fries";
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" } },
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, productCode: "CF-43", optionProductCodes: {} },
  { id: FRIES, type: "always_included", label: "French fries", productCode: "CF-11" },
];
const ev = {
  cake: randomUUID(), body: randomUUID(), rice: randomUUID(), riceSame: randomUUID(), link: randomUUID(), on: randomUUID(), off: randomUUID(), more: randomUUID(),
  // The lane's review: the editor's own uncoded copy, the day-of view's, and a repeat of a kids' extra.
  riceCopy: randomUUID(), riceDay: randomUUID(), riceTill: randomUUID(), onExtra: randomUUID(), offExtra: randomUUID(),
};

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  if (req.get("x-test-as") !== "manager") return res.status(401).json({ message: "Not signed in" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the routes read the session's user off the request
  const r = req as any;
  r.isAuthenticated = () => true;
  r.user = { id: manager, tenantId: tenant, role: "manager" };
  r.userWithAccess = { id: manager, tenantId: tenant, isActive: true, role: "manager", hasAllBranchesAccess: false, allowedBranchIds: [park] };
  next();
}
const servers: Server[] = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
beoRoutes.registerBeoRoutes(app);
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function send(method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-test-as": "manager" }) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an answer read field by field
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const tillWriters = {
  lockKitchenPlanMutation: beoRoutes.lockKitchenPlanMutation,
  kitchenPlanDbDataOf: beoRoutes.kitchenPlanDbDataOf,
  writeKitchenPlanRow: beoRoutes.writeKitchenPlanRow,
  barPlanDbDataOf: beoRoutes.barPlanDbDataOf,
  writeBarPlanRow: beoRoutes.writeBarPlanRow,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a row read field by field
const planOf = async (eventId: string) => (await q<Record<string, any>>("select * from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a view row read field by field
const viewOf = async (eventId: string) => (await q<Record<string, any>>("select kitchen_plan from otoapp_v.event_packages where event_id = $1", [eventId]))[0]?.kitchen_plan ?? null;
const kitchenPlan = (id: string, menus: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  q(
    `insert into beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus, simplified_menus, cake_mode, cake_quantity, cake_time, cake_notes)
     values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
    [randomUUID(), id, over.setMenu ?? true, (over.setMenu ?? true) ? setMenuId : null, JSON.stringify(menus), over.cakeMode ?? "NONE", over.cakeQuantity ?? 1, over.cakeTime ?? null, over.cakeNotes ?? null],
  );
/** The rows of a PDF's tables, each as its text reads ("3x Margherita — kids only EXTRA 400฿ each"). */
const rowsOf = (html: string) =>
  html.split("<tr>").slice(1).map((r) => r.slice(0, r.indexOf("</tr>")).replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim());
const pdf = (kitchen: NonNullable<PdfData["kitchenPlan"]>, over: Partial<PdfData> = {}) =>
  beoPdfHtml({ eventTitle: "ZZ TEST 978", eventDate: "2099-12-16", startTime: "15:00", status: "upcoming", kitchenPlan: kitchen, ...over } as PdfData);
const set = (itemName: string, groupId: string) => ({ quantity: 1, itemName, notes: `(${groupId === PIZZA ? "Pizza" : "Fried rice"})`, source: "set_menu", groupId });
/** A body the day-of door's shape takes (server/lib/kitchenPlanBody.ts), or the reason it does not. */
const parsed = (what: string, body: unknown) => {
  const r = kitchenPlanPutBodySchema.safeParse(body);
  assert.equal(r.success, true, `${what}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
};

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 978 ${run}`, `zz-978-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST 978 park', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, randomUUID()]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 978', 'manager', true, false)", [manager, `zz-978-${run}@example.com`]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'ZZ TEST 978 set menu', $3)", [setMenuId, tenant, JSON.stringify(setMenuItems)]);
  for (const [name, id] of Object.entries(ev)) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
       values ($1, $2, $3, 'birthday', $4, '2099-12-16', '15:00', '17:00', 12, 8, 'upcoming')`,
      [id, tenant, park, `ZZ TEST 978 ${name} ${run}`],
    );
    await q("insert into beo_package_snapshots (id, event_id, package_name, base_price) values ($1, $2, 'ZZ TEST package', 1690000)", [randomUUID(), id]);
  }

  // --- 1 and 2. The BEO PDF ------------------------------------------------------------------------
  await check("the PDF prints the adults' own extra at its own price, as the editor and the till have it", async () => {
    // The proof's thread R (pictures h06, h07): kids Margherita 3 at 400, adults 2 at 450.
    const kids = [set("Hawaiian", PIZZA), { quantity: 3, itemName: "Margherita", price: 400, source: "additional", productCode: "CF-24" }];
    const adults = [set("Hawaiian", PIZZA), { quantity: 2, itemName: "Margherita", price: 450, source: "additional", productCode: "CF-24" }];
    const rows = rowsOf(await pdf({ required: true, setMenuEnabled: true, setMenuTemplateName: "ZZ TEST set", menus: { kids, adults, adultsDiffer: true } }));
    assert.ok(rows.includes("3x Margherita — kids only EXTRA 400฿ each"), JSON.stringify(rows));
    assert.ok(rows.includes("2x Margherita — adults only EXTRA 450฿ each"), JSON.stringify(rows));
    assert.equal(rows.some((r) => r.includes("kids 3 · adults 2")), false, "never one row at the kids' price");
    // The same price each: one row, the two counts beside it, as before.
    const same = rowsOf(await pdf({ required: true, setMenuEnabled: true, menus: { kids, adults: [adults[0]!, { ...adults[1]!, price: 400 }], adultsDiffer: true } }));
    assert.ok(same.includes("3x Margherita — kids 3 · adults 2 EXTRA 400฿ each"), JSON.stringify(same));
    assert.equal(same.some((r) => r.includes("adults only")), false);
    // The one dish the till charges once (name, count and code): folded, whatever the adults' copy says.
    const once = rowsOf(await pdf({ required: true, setMenuEnabled: false, menus: { kids: [{ ...kids[1]!, quantity: 2 }], adults: [{ ...adults[1]! }], adultsDiffer: true } }));
    assert.deepEqual(once, ["2x Margherita EXTRA 400฿ each"], "charged once, with the kids' line");
    // A SET dish for the kids and an EXTRA of it for the adults: two rows, the adults' at its price.
    const kinds = rowsOf(await pdf({ required: true, setMenuEnabled: true, menus: { kids: [set("Margherita", PIZZA)], adults: [{ quantity: 3, itemName: "Margherita", price: 300, source: "additional", productCode: "CF-24" }], adultsDiffer: true } }));
    assert.ok(kinds.includes("Margherita (Pizza) — kids only SET"), JSON.stringify(kinds));
    assert.ok(kinds.includes("3x Margherita — adults only EXTRA 300฿ each"), JSON.stringify(kinds));
    // A note of the adults' own on the same line still folds ("adults: <note>"), as before.
    const noted = rowsOf(await pdf({ required: true, setMenuEnabled: false, menus: { kids: [{ ...kids[1]! }], adults: [{ ...kids[1]!, notes: "no basil" }], adultsDiffer: true } }));
    assert.deepEqual(noted, ["3x Margherita — adults: no basil EXTRA 400฿ each"]);
    // The rule itself (shared/beoExtras.ts).
    const fold = beoPrintFoldable({ till: { known: false, byCode: new Map() }, partyDate: "2099-12-16" });
    assert.deepEqual([fold(kids[1]!, adults[1]!), fold(kids[1]!, { ...adults[1]!, price: 400 }), fold(kids[0]!, adults[0]!)], [false, true, true]);
  });

  await check("the PDF reads the kids' list from menus, as the editor and the till do", async () => {
    const rows = rowsOf(await pdf({
      required: true, setMenuEnabled: false,
      menus: { kids: [{ quantity: 2, itemName: "ZZ menus dish", source: "additional", price: 120 }] },
      simplifiedMenus: { kids: [{ itemName: "ZZ stale simplified dish", source: "additional" }] },
    }));
    assert.deepEqual(rows, ["2x ZZ menus dish EXTRA 120฿ each"]);
    const old = rowsOf(await pdf({ required: true, setMenuEnabled: false, simplifiedMenus: { kids: [{ itemName: "ZZ only simplified", source: "additional", price: 90, quantity: 1 } as never] } }));
    assert.deepEqual(old, ["1x ZZ only simplified EXTRA 90฿ each"], "a plan with no menus list: simplifiedMenus, as before");
  });

  await check("PARTY HOST and SETUP PLAN print only with something under them", async () => {
    // What the PDF route builds after the editor's Save of a BEO with no host and no setup.
    const afterSave = await pdf({ required: true, menus: { kids: [] } }, {
      partyHost: { assignedName: undefined, backupName: undefined, roleName: undefined, responsibilities: undefined, notes: undefined },
      setupPlan: { readyBy: undefined, responsible: undefined, tasks: undefined, notes: undefined },
    });
    assert.equal(afterSave.includes("<h2>Party Host</h2>"), false);
    assert.equal(afterSave.includes("<h2>Setup Plan</h2>"), false);
    const filled = await pdf({ required: true, menus: { kids: [] } }, { partyHost: { assignedName: "ZZ Noi" }, setupPlan: { readyBy: "13:30" } });
    assert.ok(filled.includes("<h2>Party Host</h2>") && filled.includes("ZZ Noi"));
    assert.ok(filled.includes("<h2>Setup Plan</h2>") && filled.includes("13:30"));
    const tasksOnly = await pdf({ required: true, menus: { kids: [] } }, { setupPlan: { tasks: [{ itemLabel: "ZZ balloons" }] } });
    assert.ok(tasksOnly.includes("<h2>Setup Plan</h2>") && tasksOnly.includes("ZZ balloons"));
  });

  // --- 3. The cake count through the editor's Save -----------------------------------------------
  await check("the editor's Save writes the cake count: the row, the BEO's read and the till's plan view", async () => {
    await kitchenPlan(ev.cake, { kids: [line("k1", "Nuggets", 8)], adults: [], adultsDiffer: false }, { setMenu: false, cakeMode: "INTERNAL", cakeQuantity: 1, cakeTime: "16:00", cakeNotes: "ZZ unicorn" });
    // The editor's own kitchenPlan, as saveMutation builds it (beo-event-editor.tsx), the count changed to 3.
    const kitchen = {
      foodRequired: true, cakeMode: "INTERNAL", cakeQuantity: 3, cakeNotes: "ZZ unicorn", cakeTime: "16:00", cakePrice: 800, cakeIncluded: false,
      setMenuEnabled: false, setMenuTemplateId: null, setMenuSelectionSubmittedAt: null,
      menus: { kids: [line("k1", "Nuggets", 8)], adults: [], adultsDiffer: false, kidsFoodTime: "", adultsFoodTime: "" }, serviceSchedule: [],
    };
    const saved = await send("PUT", `/api/events/${ev.cake}/beo`, { kitchenPlan: kitchen, barPlan: { serviceTime: "", items: [] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await planOf(ev.cake))!.cake_quantity, 3, "the row");
    const read = await send("GET", `/api/events/${ev.cake}/beo`);
    assert.equal(read.body?.kitchenPlan?.cakeQuantity, 3, "the BEO's read: the editor opens with 3");
    assert.deepEqual((await viewOf(ev.cake))?.cake, { mode: "INTERNAL", qty: 3, time: "16:00", notes: "ZZ unicorn" }, "the till's plan view");
    // The till's kitchen edit sends no count: the plan keeps its 3.
    const till = await applyTillKitchenEdit(appDb, tillWriters, { id: ev.cake, tenantId: tenant }, {
      id: randomUUID(), editedAt: new Date().toISOString(), by: { name: "ZZ Noi", role: "Manager" },
      changes: [{ op: "cake", time: "16:30", note: "ZZ rainbow" }, { op: "set", lineId: "k1", qty: 9 }],
    });
    assert.equal(till.ok, true, JSON.stringify(till));
    assert.deepEqual((await viewOf(ev.cake))?.cake, { mode: "INTERNAL", qty: 3, time: "16:30", notes: "ZZ rainbow" }, "the till's edit keeps the count");
    // Back to 1 in the editor: written too; a count that is no count is never written.
    assert.equal((await send("PUT", `/api/events/${ev.cake}/beo`, { kitchenPlan: { ...kitchen, cakeQuantity: 1 } })).status, 200);
    assert.equal((await planOf(ev.cake))!.cake_quantity, 1);
    assert.equal((await send("PUT", `/api/events/${ev.cake}/beo`, { kitchenPlan: { ...kitchen, cakeQuantity: 0 } })).status, 200);
    assert.equal((await planOf(ev.cake))!.cake_quantity, 1, "0 is no count: the plan keeps 1");
    assert.deepEqual(
      [3, 99, 100, 0, -1, 2.5, "2", null, undefined].map((n) => "cakeQuantity" in beoRoutes.kitchenPlanDbDataOf({ cakeQuantity: n })),
      [true, true, false, false, false, false, false, false, false],
    );
  });

  // --- 4. The kitchen plan's body ----------------------------------------------------------------
  await check("the day-of view's door refuses a malformed body with its reason and writes nothing", async () => {
    const menus = { kids: [line("k1", "Nuggets", 8, { productCode: "CF-14" })], adults: [], adultsDiffer: false, kidsFoodTime: "14:00", cakePrice: 0, cakeIncluded: true };
    await kitchenPlan(ev.body, menus, { setMenu: false });
    const before = JSON.stringify(await planOf(ev.body));
    const refusals: Array<[unknown, RegExp]> = [
      [{ menus: { ...menus, kids: "Nuggets" } }, /^The kitchen plan was not saved: menus\.kids: a food list is a list of lines\.$/],
      [{ menus: { ...menus, kids: [{ ...menus.kids[0], quantity: 0 }] } }, /menus\.kids\.0\.quantity: a count is 1 or more\.$/],
      [{ menus: { ...menus, kids: [{ ...menus.kids[0], quantity: 2.5 }] } }, /menus\.kids\.0\.quantity: a count is a whole number\.$/],
      [{ menus: { ...menus, kids: [{ ...menus.kids[0], quantity: "8" }] } }, /menus\.kids\.0\.quantity: a count is a whole number\.$/],
      [{ menus: { ...menus, kids: [{ ...menus.kids[0], price: "120" }] } }, /menus\.kids\.0\.price: a price is a number of baht\.$/],
      [{ menus: { ...menus, kids: [{ ...menus.kids[0], price: -5 }] } }, /menus\.kids\.0\.price: a price is 0 or more\.$/],
      [{ menus: { ...menus, kids: [{ quantity: 1 }] } }, /menus\.kids\.0\.itemName: each line has a name\.$/],
      [{ menus: { ...menus, adults: [null] } }, /menus\.adults\.0: /],
      [{ menus: { ...menus, kidsFoodTime: "noon" } }, /menus\.kidsFoodTime: a time is written as HH:mm, or left empty\.$/],
      [{ menus: { ...menus, adultsDiffer: "yes" } }, /menus\.adultsDiffer: "Different for adults" is on or off\.$/],
      [{ menus: "kids" }, /^The kitchen plan was not saved: menus: the menus are an object\.$/],
      [{ foodRequired: "no" }, /foodRequired: "Kitchen required" is on or off\.$/],
      [{ setMenuTemplateId: "the pizza one" }, /setMenuTemplateId: the set menu is named by its id\.$/],
      [{ cakeQuantity: 0 }, /cakeQuantity: the cake count is 1 or more\.$/],
      [{ cakeMode: "BIG" }, /cakeMode: the cake is NONE, INTERNAL or EXTERNAL\.$/],
      [[1, 2], /the kitchen plan is an object\.$/],
    ];
    for (const [body, reason] of refusals) {
      const res = await send("PUT", `/api/events/${ev.body}/beo/kitchen-plan`, body);
      assert.equal(res.status, 400, JSON.stringify([body, res.body]));
      assert.match(String(res.body?.error), reason, JSON.stringify(body));
    }
    assert.equal(JSON.stringify(await planOf(ev.body)), before, "nothing written");
  });

  await check("the day-of view's every body is taken, and only the plan's own fields are written", async () => {
    const row = await planOf(ev.body);
    // As beo-day-of-view.tsx sends them: buildMenusPayload (the plan's own keys spread), the switches.
    const menus = { ...row!.menus, kids: [...row!.menus.kids, { id: "menu_1", itemName: "", quantity: 1, notes: "", included: true, price: 0 }], adults: [], adultsDiffer: false, kidsFoodTime: "14:30", adultsFoodTime: "" };
    for (const body of [
      { menus, setMenuSelectionSubmittedAt: null },
      { foodRequired: false, setMenuSelectionSubmittedAt: null },
      { foodRequired: true, setMenuSelectionSubmittedAt: null },
      { setMenuEnabled: true, setMenuTemplateId: setMenuId, setMenuSelectionSubmittedAt: null },
      { setMenuEnabled: false, setMenuTemplateId: null, setMenuSelectionSubmittedAt: null },
      // The adults' own list with the switch, as "Different for adults" writes it.
      { menus: { ...menus, adults: [{ ...menus.kids[0], id: "k1_adults", quantity: 4 }], adultsDiffer: true }, setMenuSelectionSubmittedAt: null },
      // tests/set-menu-persistence.spec.ts: lines with no count, and simplifiedMenus beside menus.
      { menus: { kids: [{ id: "staff_added", itemName: "Staff-added item", source: "additional" }], adults: [], kidsFoodTime: "12:30" }, simplifiedMenus: { kids: [{ id: "staff_added", itemName: "Staff-added item", source: "additional" }], adults: [] } },
    ]) {
      const res = await send("PUT", `/api/events/${ev.body}/beo/kitchen-plan`, body);
      assert.equal(res.status, 200, JSON.stringify([body, res.body]));
    }
    const after = await planOf(ev.body);
    assert.equal(after!.food_required, true);
    assert.deepEqual(after!.menus.kids.map((l: Line) => l.itemName), ["Staff-added item"]);
    // The row's own id and event never come from a body.
    const id = after!.id;
    assert.equal((await send("PUT", `/api/events/${ev.body}/beo/kitchen-plan`, { id: randomUUID(), eventId: ev.rice, kitchenResolvedUserId: manager, foodRequired: true })).status, 200);
    const kept = await planOf(ev.body);
    assert.deepEqual([kept!.id, kept!.event_id, kept!.kitchen_resolved_user_id], [id, ev.body, null]);
  });

  await check("the shape takes what the editor's Save and the till's kitchen edit write", async () => {
    // The editor's Save (beo-event-editor.tsx saveMutation's kitchenPlan), its lines as mapMenu holds them.
    parsed("the editor's Save", {
      foodRequired: true, cakeMode: "INTERNAL", cakeQuantity: 2, cakeNotes: "", cakeTime: "", cakePrice: 0, cakeIncluded: true,
      setMenuEnabled: true, setMenuTemplateId: setMenuId, setMenuSelectionSubmittedAt: "2026-11-13T00:29:19.148Z",
      menus: {
        kids: [{ id: "set_x", itemName: "Hawaiian", quantity: 1, notes: "(Pizza)", included: true, price: 0, source: "set_menu", groupId: PIZZA }, { id: "m1", itemName: "Margherita", quantity: 3, notes: "", included: false, price: 400, source: "additional", groupId: undefined, productCode: "CF-24" }],
        adults: [], adultsDiffer: false, kidsFoodTime: "14:00", adultsFoodTime: "",
      },
      serviceSchedule: [],
    });
    // The till's kitchen edit's plan (server/lib/tillKitchenEdit.ts), as it hands the BEO's Save writer.
    // The AI approval's row is read in check 8, once it is written.
    const row = (await planOf(ev.cake))!;
    const planned = planTillKitchenEdit(
      {
        kitchen: { foodRequired: row.food_required, cakeMode: row.cake_mode, cakeNotes: row.cake_notes, cakeTime: row.cake_time, serviceSchedule: row.service_schedule, setMenuEnabled: row.set_menu_enabled, setMenuTemplateId: row.set_menu_template_id, menus: row.menus },
        bar: null,
        template: null,
      },
      [{ op: "add", id: randomUUID(), list: "food", name: "ZZ Calamari", productCode: "CF-14", qty: 2 }, { op: "set", lineId: "k1", qty: 10, note: "no sauce" }, { op: "cake", time: "16:45" }],
    );
    assert.equal(planned.ok, true, JSON.stringify(planned));
    if (planned.ok) parsed("the till's kitchen edit", planned.kitchen);
  });

  // --- 5. The fill's reading of the chat's words ---------------------------------------------------
  await check("a date or a clock time is never the chat's total; a total stays one", () => {
    const names = ["Margherita pizzas", "Margherita", "пиццы маргарита", "มาการิต้า"];
    const total = (text: string) => chatTotalOf(text, names, 2);
    for (const words of [
      "2 Margherita pizzas for 25/12", "2 Margherita pizzas for 12/25 please", "2 Margherita pizzas for 25-12", "2 Margherita pizzas for 2026-12-25",
      "2 Margherita pizzas for 25.12", "2 Margherita pizzas for 25.12.2026", "2 Margherita pizzas for 15:00", "2 Margherita pizzas for 21.30",
      "2 Margherita pizzas for 3pm", "2 Margherita pizzas for 25 December", "2 Margherita pizzas for December 25", "2 Margherita pizzas for 25 Dec.",
      "มาการิต้า 2 ถาด for 25 ธ.ค.", "2 пиццы маргарита за 25 декабря", "2 Margherita pizzas for 15 น.",
    ]) {
      assert.equal(total(words), null, words);
    }
    for (const [words, amount] of [
      ["2 Margherita pizzas for 900", 900], ["2 Margherita pizzas for 900 baht", 900], ["2 Margherita pizzas, 900 for 2", 900],
      ["Margherita pizza x2 - 900 baht total", 900], ["2 Margherita pizzas for 1,800", 1800], ["2 пиццы маргарита за 900", 900],
    ] as const) {
      assert.deepEqual(total(words), { amount, quantity: 2 }, words);
    }
  });

  await check("the fold's reason quotes the words that say the adults eat the same", () => {
    const menu = { name: "ZZ TEST set", items: setMenuItems as never };
    const from = { source: "family" as const, at: "2099-11-13T00:00:00.000Z", line: 2 };
    const quote = (text: string) => adultsSameAsKidsFolds([{ text, from }], menu, [{ itemId: PIZZA, option: "Margherita" }], [], []).map((f) => f.from.quote);
    assert.deepEqual(quote("Margherita pizza for the kids, and the same for the adults."), ["and the same for the adults"]);
    assert.deepEqual(quote("The adults will eat the same as the kids, the Margherita pizza for them too."), ["the Margherita pizza for them too"], "the dish's own words say it: as before");
    assert.deepEqual(quote("Margherita pizza for the kids and the adults too."), ["Margherita pizza for the kids and the adults too"]);
  });

  await check("ต่อ is \"per\" only before a count or a unit", () => {
    assert.equal(figureSaidEach("พิซซ่า 2 ถาด 900 บาท ติดต่อได้ที่เบอร์นี้", 900), false, "ติดต่อ: contact");
    assert.equal(figureSaidEach("พิซซ่า 2 ถาด 900 บาท ต่อไปเรื่องเค้ก", 900), false, "ต่อไป: next");
    assert.equal(chatPriceIsTotal("พิซซ่า 2 ถาด รวม 900 บาท ติดต่อกลับ", 900, 2), true, "a total beside ติดต่อ stays a total");
    assert.equal(figureSaidEach("พิซซ่า 450 บาทต่อถาด", 450), true, "บาทต่อถาด: per tray");
    assert.equal(figureSaidEach("ราคา 450 บาท ต่อคน", 450), true, "ต่อคน: per person");
    assert.equal(figureSaidEach("450 ต่อ 1 ชิ้น", 450), true);
  });

  // --- 6. The adults' set line in another count ---------------------------------------------------
  await check("the adults' set line in another count keeps its till code, on the row and on the till", async () => {
    const kidsChicken = line(`set_${RICE}_Chicken`, "Chicken", 12, { notes: "(Fried rice)", source: "set_menu", groupId: RICE, included: true });
    const save = (eventId: string, adultsQty: number) => send("PUT", `/api/events/${eventId}/beo`, {
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: true, setMenuTemplateId: setMenuId, setMenuSelectionSubmittedAt: null, serviceSchedule: [],
        menus: { kids: [kidsChicken], adults: [{ ...kidsChicken, id: `${kidsChicken.id}_adults`, quantity: adultsQty, productCode: "CF-43" }], adultsDiffer: true, kidsFoodTime: "", adultsFoodTime: "" },
      },
    });
    for (const [eventId, qty] of [[ev.rice, 8], [ev.riceSame, 12]] as const) {
      await kitchenPlan(eventId, { kids: [], adults: [] });
      assert.equal((await save(eventId, qty)).status, 200);
    }
    const adultsOf = async (eventId: string) => (await planOf(eventId))!.menus.adults.map((l: Line) => [l.itemName, l.quantity, l.productCode ?? null]);
    assert.deepEqual(await adultsOf(ev.rice), [["Chicken", 8, "CF-43"]], "kids 12, adults 8: the adults' own line keeps CF-43");
    const lines = ((await viewOf(ev.rice))?.lines ?? []) as Array<Record<string, unknown>>;
    const adults = lines.filter((l) => l.audience === "adults");
    assert.deepEqual(adults.map((l) => [l.name, l.qty, l.product_code]), [["Chicken", 8, "CF-43"]], `the till names and codes it: ${JSON.stringify(lines)}`);
    // The case the view folds (the same count): uncoded as the kids' copy, read once, as before.
    assert.deepEqual(await adultsOf(ev.riceSame), [["Chicken", 12, null]]);
    assert.deepEqual(((await viewOf(ev.riceSame))?.lines ?? []).filter((l: Record<string, unknown>) => l.audience === "adults"), []);
    // Pure.
    const kids = [{ itemName: "Chicken", quantity: 12, source: "set_menu", groupId: RICE }];
    assert.deepEqual(
      adultsSetCopiesUncoded(kids, [
        { itemName: "Chicken", quantity: 8, source: "set_menu", groupId: RICE, productCode: "CF-43" },
        { itemName: "Chicken", quantity: 12, source: "set_menu", groupId: RICE, productCode: "CF-43" },
      ]).map((l) => l.productCode ?? null),
      ["CF-43", null],
    );

    // The lane's review: the editor's own "Different for adults" copy of the kids' set line carries no code
    // (the kids' line carries none); staff then give the adults 8. The editor's Save codes it from the set
    // menu, as the till reads the kids' line: the till names it, never "not on the till menu".
    await kitchenPlan(ev.riceCopy, { kids: [], adults: [] });
    const copy = await send("PUT", `/api/events/${ev.riceCopy}/beo`, {
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: true, setMenuTemplateId: setMenuId, setMenuSelectionSubmittedAt: null, serviceSchedule: [],
        menus: { kids: [kidsChicken], adults: [{ ...kidsChicken, id: "menu_copy_0", quantity: 8 }], adultsDiffer: true, kidsFoodTime: "", adultsFoodTime: "" },
      },
    });
    assert.equal(copy.status, 200, JSON.stringify(copy.body));
    assert.deepEqual(await adultsOf(ev.riceCopy), [["Chicken", 8, "CF-43"]], "the editor's copy at 8: coded from the set menu");
    const copyView = ((await viewOf(ev.riceCopy))?.lines ?? []).filter((l: Record<string, unknown>) => l.audience === "adults");
    assert.deepEqual(copyView.map((l: Record<string, unknown>) => [l.name, l.qty, l.product_code]), [["Chicken", 8, "CF-43"]], "the till names and codes it");
    // The same through the day-of view's door, for a copy saved uncoded at the kids' count whose count is
    // changed later: coded once it is the adults' own.
    await kitchenPlan(ev.riceDay, { kids: [kidsChicken], adults: [{ ...kidsChicken, id: "menu_copy_0" }], adultsDiffer: true });
    const day = await send("PUT", `/api/events/${ev.riceDay}/beo/kitchen-plan`, {
      menus: { kids: [kidsChicken], adults: [{ ...kidsChicken, id: "menu_copy_0", quantity: 6 }], adultsDiffer: true, kidsFoodTime: "", adultsFoodTime: "" },
      setMenuSelectionSubmittedAt: null,
    });
    assert.equal(day.status, 200, JSON.stringify(day.body));
    assert.deepEqual(await adultsOf(ev.riceDay), [["Chicken", 6, "CF-43"]], "the day-of view's copy at 6");
    // And a plan written before this fix (the adults' Chicken 8 uncoded, the till's "not on the till
    // menu" line): the till's own edit of that line writes it coded.
    await kitchenPlan(ev.riceTill, { kids: [kidsChicken], adults: [{ ...kidsChicken, id: "menu_copy_0", quantity: 8 }], adultsDiffer: true });
    const later = await applyTillKitchenEdit(appDb, tillWriters, { id: ev.riceTill, tenantId: tenant }, {
      id: randomUUID(), editedAt: new Date().toISOString(), by: { name: "ZZ Noi", role: "Manager" },
      changes: [{ op: "set", lineId: "menu_copy_0", qty: 9 }],
    });
    assert.equal(later.ok, true, JSON.stringify(later));
    assert.deepEqual(await adultsOf(ev.riceTill), [["Chicken", 9, "CF-43"]], "the till's edit to 9: coded");
    // Back at the kids' count: uncoded again and read once, as before.
    assert.equal((await send("PUT", `/api/events/${ev.riceCopy}/beo`, {
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: true, setMenuTemplateId: setMenuId, setMenuSelectionSubmittedAt: null, serviceSchedule: [],
        menus: { kids: [kidsChicken], adults: [{ ...kidsChicken, id: "menu_copy_0", quantity: 12, productCode: "CF-43" }], adultsDiffer: true, kidsFoodTime: "", adultsFoodTime: "" },
      },
    })).status, 200);
    assert.deepEqual(await adultsOf(ev.riceCopy), [["Chicken", 12, null]]);
    assert.deepEqual(((await viewOf(ev.riceCopy))?.lines ?? []).filter((l: Record<string, unknown>) => l.audience === "adults"), []);
    // Pure: the option's own code, else its group's; an item always included, its own; the line the view
    // folds, a line of no set-menu group or of a group the set menu lacks: as they are.
    const kidsSet = [...kids, { itemName: "Margherita", quantity: 1, source: "set_menu", groupId: PIZZA }, { itemName: "French fries", quantity: 1, source: "set_menu", groupId: FRIES }];
    assert.deepEqual(
      adultsSetLinesTillCoded(kidsSet, [
        { itemName: "Chicken", quantity: 8, source: "set_menu", groupId: RICE },
        { itemName: "Chicken", quantity: 12, source: "set_menu", groupId: RICE },
        { itemName: "Margherita", quantity: 8, source: "set_menu", groupId: PIZZA },
        { itemName: "French fries", quantity: 8, source: "set_menu", groupId: FRIES },
        { itemName: "Nuggets", quantity: 8, source: "additional" },
        { itemName: "Chicken", quantity: 8, source: "set_menu", groupId: "item_zz978_none" },
        { itemName: "Chicken", quantity: 8, source: "set_menu", groupId: RICE, productCode: "CF-99" },
      ], setMenuItems).map((l) => l.productCode ?? null),
      ["CF-43", null, "CF-24", "CF-11", null, null, "CF-99"],
    );
  });

  // --- 7. The family's link: the park's day ---------------------------------------------------------
  await check("the family's link answers its park's time zone and prints the park's day", async () => {
    const token = `zz978${randomUUID().replace(/-/g, "")}`;
    // Chosen at 02:28 on 13 November at the park (19:28 UTC on the 12th).
    await q("insert into beo_set_menu_selections (event_id, template_id, token, is_submitted, submitted_at, selections) values ($1, $2, $3, true, '2099-11-12T19:28:45Z', '[]')", [ev.link, setMenuId, token]);
    const read = await send("GET", `/api/beo/set-menu-selections/public/${token}`, undefined, {});
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.parkTimeZone, "Asia/Bangkok");
    assert.deepEqual(Object.keys(read.body.event).sort(), ["childName", "eventDate", "title"], "the event's fields as before");
    assert.equal(parkDayOf(read.body.submittedAt, read.body.parkTimeZone, "en-GB"), "13/11/2099", "the park's day");
    assert.equal(parkDayOf("2099-11-12T19:28:45.000Z", "Europe/London", "en-GB"), "12/11/2099", "another park's own clock");
    assert.equal(parkDayOf("2099-11-12T19:28:45.000Z", null, "en-GB"), "13/11/2099", "none: the park group's own");
    assert.equal(parkDayOf("2099-11-12T19:28:45.000Z", "Not/AZone", "en-GB"), "13/11/2099", "a zone the clock does not know: the default");
    assert.equal(parkDayOf("not a moment", "Asia/Bangkok"), "");
  });

  // --- 8. The approval with "Different for adults" already on ---------------------------------------
  await check("an adults' repeat of the kids' dish is no charged extra, the switch on or off; 3 more stays one", async () => {
    const own = line("own_1", "ZZ Caesar salad", 4, { price: 180, source: "additional" });
    await kitchenPlan(ev.on, { kids: [], adults: [own], adultsDiffer: true });
    await kitchenPlan(ev.off, { kids: [], adults: [], adultsDiffer: false });
    await kitchenPlan(ev.more, { kids: [], adults: [own], adultsDiffer: true });
    const approve = (eventId: string, adultsLine: Record<string, unknown>) => {
      const body = BeoAiApproveBodySchema.parse({
        conversationId: null, messageId: null, package: null,
        setMenu: { templateId: setMenuId, choices: [{ itemId: PIZZA, options: ["Margherita"] }] },
        menuLines: [{ menu: "adults", productCode: "CF-24", notes: null, ...adultsLine }],
        entertainment: [], otherLines: [], event: { numAdults: 8 }, cake: null, deposit: null, sources: [],
      });
      return approveBeoAiFill(appDb, { event: { id: eventId, tenantId: tenant, branchId: park, title: `ZZ TEST 978 ${run}` }, userId: manager, body, now: new Date(), recordActivity: async () => undefined });
    };
    const repeat = { itemName: "Margherita", quantity: 1 };
    const adultsOf = async (eventId: string) => {
      const plan = (await planOf(eventId))!;
      return { differ: plan.menus.adultsDiffer, lines: plan.menus.adults.map((l: Line) => `${l.source === "set_menu" ? "SET" : "EXTRA"} ${l.itemName} x${l.quantity}${l.price ? ` @${l.price}` : ""}`) };
    };
    const on = await approve(ev.on, repeat);
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.deepEqual(await adultsOf(ev.on), { differ: true, lines: ["SET Margherita x1", "SET French fries x1", "EXTRA ZZ Caesar salad x4 @180"] }, "on: the set menu's dish as SET, never an EXTRA beside it");
    if (on.ok) assert.deepEqual([on.written.adultsLinesFolded, on.written.adultsMenuOwn], [1, true], "the toast says the fold");
    const off = await approve(ev.off, repeat);
    assert.equal(off.ok, true, JSON.stringify(off));
    assert.deepEqual(await adultsOf(ev.off), { differ: false, lines: [] }, "off: the adults eat the kids' menu, as before");
    // "3 more Margherita pizzas for the adults": an order on top, an EXTRA as before.
    const more = await approve(ev.more, { itemName: "3 more Margherita pizzas", quantity: 3 });
    assert.equal(more.ok, true, JSON.stringify(more));
    const moreLines = (await adultsOf(ev.more)).lines;
    assert.ok(moreLines.some((l: string) => /^EXTRA Margherita x3/.test(l)), JSON.stringify(moreLines));
    assert.ok(moreLines.includes("SET Margherita x1"), "beside the set menu's own");
    const viewed = ((await viewOf(ev.on))?.lines ?? []).filter((l: Record<string, unknown>) => l.source === "extra" && l.name === "Margherita");
    assert.deepEqual(viewed, [], "the till charges no Margherita extra on the switch-on party");

    // The lane's review: a repeat of a kids' line that is NO set-menu dish (the kids' own extra, ZZ Nuggets
    // 12 at 100) with the switch already on is never dropped and never said to come "from the set menu":
    // the adults' own menu holds the kids' line itself, so the till and the PDF read the one dish, once,
    // as with the switch off (where the adults eat the kids' list, the Nuggets with it).
    const nuggets = line("k_n", "ZZ Nuggets", 12, { price: 100, source: "additional" });
    await kitchenPlan(ev.onExtra, { kids: [nuggets], adults: [own], adultsDiffer: true });
    await kitchenPlan(ev.offExtra, { kids: [nuggets], adults: [], adultsDiffer: false });
    const sameAsKids = { itemName: "ZZ Nuggets", quantity: 8, productCode: null, notes: "the same as the kids" };
    const onExtra = await approve(ev.onExtra, sameAsKids);
    assert.equal(onExtra.ok, true, JSON.stringify(onExtra));
    assert.deepEqual(
      await adultsOf(ev.onExtra),
      { differ: true, lines: ["SET Margherita x1", "SET French fries x1", "EXTRA ZZ Caesar salad x4 @180", "EXTRA ZZ Nuggets x12 @100"] },
      "on: the kids' Nuggets line on the adults' own menu, as it is",
    );
    if (onExtra.ok) {
      assert.deepEqual([onExtra.written.adultsLinesFolded, onExtra.written.adultsMenuOwn, onExtra.written.adultsKidsLinesCopied], [undefined, undefined, 1]);
      const words = approvalResultWords({ written: onExtra.written });
      assert.ok(words.endsWith(` ${adultsFoldedAsKidsLineWords(1)}`), words);
      assert.equal(words.includes("from the set menu"), false, "never said to come from the set menu");
    }
    const nuggetsOn = ((await viewOf(ev.onExtra))?.lines ?? []).filter((l: Record<string, unknown>) => l.name === "ZZ Nuggets");
    assert.deepEqual(nuggetsOn.map((l: Record<string, unknown>) => [l.qty, l.unit_price_satang, l.audience ?? null]), [[12, 10000, null]], "the till: one Nuggets line, 12 at 100, for everyone");
    const onRow = (await planOf(ev.onExtra))!;
    const onRows = rowsOf(await pdf({ required: true, setMenuEnabled: true, menus: onRow.menus }));
    assert.deepEqual(onRows.filter((r) => r.includes("ZZ Nuggets")), ["12x ZZ Nuggets EXTRA 100฿ each"], `the PDF: one row, no mark: ${JSON.stringify(onRows)}`);
    // Off: the adults eat the kids' menu, as before.
    const offExtra = await approve(ev.offExtra, sameAsKids);
    assert.equal(offExtra.ok, true, JSON.stringify(offExtra));
    assert.deepEqual(await adultsOf(ev.offExtra), { differ: false, lines: [] });
    if (offExtra.ok) assert.ok(approvalResultWords({ written: offExtra.written }).endsWith(` ${adultsFoldedWords(1)}`));
    const nuggetsOff = ((await viewOf(ev.offExtra))?.lines ?? []).filter((l: Record<string, unknown>) => l.name === "ZZ Nuggets");
    assert.deepEqual(nuggetsOff.map((l: Record<string, unknown>) => [l.qty, l.unit_price_satang, l.audience ?? null]), [[12, 10000, null]], "the same one line as with the switch on");
    // Check 4's shape takes the approval's row as it is written.
    for (const eventId of [ev.on, ev.off, ev.more, ev.onExtra, ev.offExtra]) {
      const row = (await planOf(eventId))!;
      parsed("the AI approval", { menus: row.menus, simplifiedMenus: row.simplified_menus, setMenuEnabled: row.set_menu_enabled, setMenuTemplateId: row.set_menu_template_id, cakeMode: row.cake_mode, cakeQuantity: row.cake_quantity, cakeTime: row.cake_time, cakeNotes: row.cake_notes });
    }
  });

  // --- 9. Fetch from chat: a kids' choice against the kids' lines ----------------------------------
  await check("Fetch from chat compares a kids' choice with the kids' lines only", () => {
    const from = { source: "family" as const, at: "2099-11-13T00:00:00.000Z", line: 2 };
    const review = {
      proposal: { package: null, addOns: [], setMenu: { templateId: setMenuId, from, choices: [{ itemId: PIZZA, option: "Margherita", from }, { itemId: RICE, option: "Veggie", from }] }, menuLines: [], entertainment: [], otherLines: [], event: {} },
      catalogue: { packages: [], setMenus: [{ id: setMenuId, name: "ZZ TEST 978 set menu", items: setMenuItems }] },
    } as never;
    const held = {
      package: null, packageItems: [], setMenuTemplateId: setMenuId, entertainment: [],
      menuLines: [
        { itemName: "Hawaiian", quantity: 1, productCode: null, groupId: PIZZA, menu: "kids" as const },
        { itemName: "Margherita", quantity: 1, productCode: "CF-24", groupId: PIZZA, menu: "adults" as const },
        { itemName: "Chicken", quantity: 1, productCode: "CF-43", groupId: RICE, menu: "adults" as const },
      ],
    };
    const changes = fetchCatalogueChangesOf(review, held, { specialRequests: "" }).filter((c) => c.section === "choice");
    assert.deepEqual(changes.map((c) => [c.label, c.was, c.now]), [["Set menu · Pizza", "Hawaiian", "Margherita"], ["Set menu · Fried rice", "—", "Veggie"]], "the adults' own dish neither hides nor stands for the kids' choice");
    const legacy = fetchCatalogueChangesOf(review, { ...held, menuLines: [{ itemName: "Margherita", quantity: 1, productCode: null, groupId: PIZZA }] }, { specialRequests: "" }).filter((c) => c.section === "choice");
    assert.deepEqual(legacy.map((c) => c.now), ["Veggie"], "a line with no list is read as the kids', as before");
  });

  console.log(`beo-left-978.check: ${checks} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from activity_log where metadata_json like any($1::text[])", [events.map((e) => `%${e}%`)]).catch(() => undefined);
  await q("delete from beo_set_menu_selections where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_set_menu_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from users where id = $1", [manager]).catch(() => undefined);
  await q("delete from branches where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from tenants where id = $1", [tenant]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}
process.exit(checks === 14 && failed.length === 0 ? 0 : 1);
