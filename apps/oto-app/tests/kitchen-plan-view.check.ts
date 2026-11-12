// seed: its own — one ZZ TEST park group, made here. Not a Playwright file: it
// mounts the BEO's own routes on a bare server and needs a database whose
// otoapp schema the app's migrator has built (0050 included).
//
// SCRUM-906 — the whole kitchen plan reaches the till (the owner's decisions
// of 12 November), the app's half:
//
//   - the till's plan view (migration 0050) publishes `kitchen_plan`: every
//     food line of the BEO's kitchen plan, coded or typed, with its badge, its
//     id and the price entered on it; the set menu's choices read from the
//     BEO's own lines, so a choice staff change after the parent submitted is
//     the till's (decision 3); a template item no line answers as 0048 gave
//     it, an open choice with no option; the adults' marks exactly as 0048
//     puts them on the coded lines; the bar's lines with their own codes, the
//     cake as the BEO's cake choice says it (decision 4) and the bar's service
//     time; a party with a kitchen plan and no package has a row (decision 8)
//     whose package names nothing; the thirteen columns of before unchanged;
//   - the parent's own link reads the choice from the same lines once
//     submitted, so the BEO, the till, the slips and the parent agree.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> npx tsx tests/kitchen-plan-view.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("kitchen-plan-view.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-906";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const { registerBeoRoutes } = await import("../server/beo-routes");
const { setMenuChoicesOfKitchenPlan } = await import("../server/lib/setMenuResolve");
const { pool: appDbPool } = await import("../server/db");

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field below
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

type Line = {
  id: string;
  itemName: string;
  quantity: number;
  notes: string;
  included: boolean;
  price: number;
  source?: string;
  productCode?: string;
  groupId?: string;
};
const line = (id: string, itemName: string, quantity = 1, over: Partial<Line> = {}): Line => ({
  id, itemName, quantity, notes: "", included: true, price: 0, ...over,
});

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const coreBranch = randomUUID();
const manager = randomUUID();
const setMenuId = randomUUID();
const RICE = "item_zz906_rice";
const FRIES = "item_zz906_fries";
const FRUIT = "item_zz906_fruit";
const PIZZA = "item_zz906_pizza";
const setMenuItems = [
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, optionProductCodes: { Chicken: "CF-50" }, qty: 3 },
  { id: FRIES, type: "always_included", label: "French fries", productCode: "CF-11", qty: 2 },
  { id: FRUIT, type: "always_included", label: "Fruit skewers", qty: 2 },
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" }, qty: 2, note: "thin crust" },
];
const ev = { staff: randomUUID(), every: randomUUID(), adults: randomUUID(), bar: randomUUID(), bare: randomUUID(), none: randomUUID(), link: randomUUID() };

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
registerBeoRoutes(app);
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function send(method: string, path: string, body?: unknown, asManager = true) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(asManager ? { "x-test-as": "manager" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an answer read field by field
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a view row read field by field
const rowOf = async (eventId: string) => (await q<Record<string, any>>("select * from otoapp_v.event_packages where event_id = $1", [eventId]))[0] ?? null;
const kitchenPlan = async (id: string, menus: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  q(
    `insert into beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus, cake_mode, cake_quantity, cake_time, cake_notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(), id, over.setMenu ?? true, (over.setMenu ?? true) ? setMenuId : null, JSON.stringify(menus),
      over.cakeMode ?? "NONE", over.cakeQuantity ?? 1, over.cakeTime ?? null, over.cakeNotes ?? null,
    ],
  );
const submitted = (id: string, chosen: Record<string, string[]>) =>
  q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted, submitted_at, selections) values ($1, $2, $3, $4, true, now(), $5)", [
    randomUUID(), id, setMenuId, `zz-906-${randomUUID()}`, JSON.stringify(Object.entries(chosen).map(([groupId, chosenOptions]) => ({ groupId, chosenOptions }))),
  ]);
/** The set menu's lines as the parent's submit writes them (server/lib/setMenuResolve.ts). */
const resolved = (rice: string, pizza: string): Line[] => [
  line(`set_${RICE}_${rice}`, rice, 3, { notes: "(Fried rice)", source: "set_menu", groupId: RICE }),
  line(`set_${FRIES}`, "French fries", 2, { source: "set_menu", groupId: FRIES }),
  line(`set_${FRUIT}`, "Fruit skewers", 2, { source: "set_menu", groupId: FRUIT }),
  line(`set_${PIZZA}_${pizza}`, pizza, 2, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA }),
];

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 906 ${run}`, `zz-906-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST 906 park', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, coreBranch]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 906', 'manager', true, false)", [manager, `zz-906-${run}@example.com`]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'ZZ TEST 906 set menu', $3)", [setMenuId, tenant, JSON.stringify(setMenuItems)]);
  for (const [key, id] of Object.entries(ev)) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
       values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming')`,
      [id, tenant, park, `ZZ TEST 906 ${key} ${run}`],
    );
    if (key !== "bare" && key !== "none") {
      await q("insert into beo_package_snapshots (id, event_id, package_name, base_price) values ($1, $2, 'ZZ TEST package', 1690000)", [randomUUID(), id]);
    }
  }

  await check("the parent's own link and the till read one record: the BEO's set-menu lines by group, a line of before by its note", () => {
    assert.deepEqual(setMenuChoicesOfKitchenPlan(setMenuItems, { kids: resolved("Chicken", "Hawaiian"), adults: [] }), [
      { groupId: RICE, chosenOptions: ["Chicken"] },
      { groupId: PIZZA, chosenOptions: ["Hawaiian"] },
    ]);
    // A line saved before groupId is found by its note "(<group>)"; an additional line of an option's name is not a choice.
    assert.deepEqual(
      setMenuChoicesOfKitchenPlan(setMenuItems, {
        kids: [line("old", "Shrimp", 3, { notes: "(Fried rice)", source: "set_menu" }), line("k1", "Margherita", 1, { source: "additional" })],
      }),
      [{ groupId: RICE, chosenOptions: ["Shrimp"] }],
    );
    // The adults' list when the kids' holds no set-menu line (a BEO saved that way before); none at all: null.
    assert.deepEqual(setMenuChoicesOfKitchenPlan(setMenuItems, { kids: [line("k1", "Nuggets")], adults: resolved("Veggie", "Margherita") }), [
      { groupId: RICE, chosenOptions: ["Veggie"] },
      { groupId: PIZZA, chosenOptions: ["Margherita"] },
    ]);
    assert.equal(setMenuChoicesOfKitchenPlan(setMenuItems, { kids: [line("k1", "Nuggets")] }), null);
    assert.equal(setMenuChoicesOfKitchenPlan(setMenuItems, null), null);
  });

  await check("decision 3: a choice staff change after the parent submitted is the till's; the thirteen columns read as 0048 gave them", async () => {
    await submitted(ev.staff, { [RICE]: ["Veggie"], [PIZZA]: ["Margherita"] });
    // The parent chose Veggie; staff changed it to Chicken in the BEO's set-menu block.
    await kitchenPlan(ev.staff, { kidsFoodTime: "14:00", kids: resolved("Chicken", "Margherita"), adults: [] });
    const row = await rowOf(ev.staff);
    assert.ok(row);
    const rice = row.kitchen_plan.lines.find((l: { choice_group: string | null }) => l.choice_group === "Fried rice");
    assert.deepEqual(rice, {
      line_id: `set_${RICE}_Chicken`, source: "set_menu", product_code: "CF-50", name: "Fried rice", qty: 3,
      choice_group: "Fried rice", chosen_option: "Chicken", note: null, unit_price_satang: null,
    });
    // The pizza's note is the template's: "(Pizza)" on the line is its group's mark, not a note.
    assert.deepEqual(
      row.kitchen_plan.lines.map((l: { name: string; chosen_option: string | null; note: string | null }) => [l.name, l.chosen_option, l.note]),
      [["Fried rice", "Chicken", null], ["French fries", null, null], ["Fruit skewers", null, null], ["Pizza", "Margherita", "thin crust"]],
    );
    // The column a platform release of before reads is as 0048 gave it: the parent's submission.
    assert.deepEqual(row.set_menu[0], { product_code: null, name: "Fried rice", qty: 3, choice_group: "Fried rice", chosen_option: "Veggie", note: null });
    assert.equal(row.kitchen_plan.version, 1);
  });

  await check("every line arrives: a typed extra with its price, a coded extra, a template item no line answers, an open choice, a fixed item's second line", async () => {
    await kitchenPlan(ev.every, {
      kids: [
        line(`set_${FRIES}`, "French fries", 4, { source: "set_menu", groupId: FRIES }),
        line("dup", "French fries", 1, { source: "set_menu", groupId: FRIES }),
        line("m1", "Mango sticky rice", 2, { notes: "no nuts", included: false, price: 120, source: "additional" }),
        line("m2", "Fried chicken", 1, { included: false, productCode: "CF-77", source: "additional" }),
        line("m3", "  ", 1, { source: "additional" }),
      ],
      adults: [],
    });
    const row = await rowOf(ev.every);
    assert.deepEqual(
      row!.kitchen_plan.lines.map((l: Record<string, unknown>) => [l.line_id, l.source, l.product_code, l.name, l.qty, l.chosen_option, l.unit_price_satang]),
      [
        // The open choice: the group, no option (staff and parent have chosen nothing).
        [null, "set_menu", null, "Fried rice", 3, null, null],
        // The fixed item takes its first line, as the BEO's block shows it: the count the BEO says.
        [`set_${FRIES}`, "set_menu", "CF-11", "French fries", 4, null, null],
        // No line answers the skewers: the template's own.
        [null, "set_menu", null, "Fruit skewers", 2, null, null],
        [null, "set_menu", null, "Pizza", 2, null, null],
        // The fixed item's second line is a line of its own; the typed and the coded extras; a nameless line is none.
        ["dup", "set_menu", null, "French fries", 1, null, null],
        ["m1", "extra", null, "Mango sticky rice", 2, null, 12000],
        ["m2", "extra", "CF-77", "Fried chicken", 1, null, null],
      ],
    );
    assert.equal(row!.kitchen_plan.lines[5].note, "no nuts");
  });

  await check("the adults' handling is 0048's: each coded line carries the marks the set_menu column gives it", async () => {
    const kids = [
      line(`set_${PIZZA}_Margherita`, "Margherita", 2, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA }),
      line(`set_${FRIES}`, "French fries", 2, { source: "set_menu", groupId: FRIES }),
      line("k1", "Kids juice", 10, { productCode: "CF-66-1", source: "additional" }),
      line("k2", "ZZ unicorn cake", 1, { productCode: "PARTY-ZZ906A", source: "additional" }),
      line("k3", "Fruit skewers", 2, { source: "additional" }),
    ];
    const adults = [
      line(`set_${FRIES}_adults`, "French fries", 2, { source: "set_menu", groupId: FRIES }),
      line("a1", "Kids juice", 10, { productCode: "CF-66-1", notes: "no ice", source: "additional" }),
      line("a2", "Steak", 4, { productCode: "PARTY-ZZ906B", source: "additional" }),
      line("a3", "Fruit skewers", 4, { source: "additional" }),
      line("a4", "Pasta", 3, { source: "additional" }),
    ];
    await submitted(ev.adults, { [PIZZA]: ["Margherita"] });
    await kitchenPlan(ev.adults, { kids, adults, adultsDiffer: true });
    const row = await rowOf(ev.adults);
    type Item = { product_code: string | null; name: string; chosen_option?: string | null; qty: number | null; audience?: string; adults_note?: string };
    const marks = (items: Item[]) =>
      items.filter((i) => i.product_code).map((i) => [i.product_code, i.chosen_option ?? i.name, i.qty, i.audience ?? null, i.adults_note ?? null]);
    // The coded lines, kids then adults, marked exactly as 0048 marks them.
    assert.deepEqual(marks(row!.kitchen_plan.lines), marks(row!.set_menu));
    assert.deepEqual(marks(row!.kitchen_plan.lines), [
      ["CF-11", "French fries", 2, null, null],
      ["CF-24", "Margherita", 2, "kids", null],
      ["CF-66-1", "Kids juice", 10, null, "no ice"],
      ["PARTY-ZZ906A", "ZZ unicorn cake", 1, "kids", null],
      ["PARTY-ZZ906B", "Steak", 4, "adults", null],
    ]);
    // And the uncoded lines beside them, marked the same way: the open rice choice, the set menu's skewers and
    // the team's own in both counts, the pasta the adults'.
    assert.deepEqual(
      row!.kitchen_plan.lines.filter((i: Item) => !i.product_code && !i.chosen_option).map((i: Item) => [i.name, i.qty, i.audience ?? null]),
      [["Fried rice", 3, null], ["Fruit skewers", 2, null], ["Fruit skewers", 2, null], ["Fruit skewers", 4, "adults"], ["Pasta", 3, "adults"]],
    );
  });

  await check("the bar's lines with their own codes, notes and prices; the cake as the BEO says it; the bar's service time", async () => {
    await kitchenPlan(ev.bar, { kids: [] }, { setMenu: false, cakeMode: "INTERNAL", cakeQuantity: 2, cakeTime: "15:30", cakeNotes: "chocolate, \"Mali 6\"" });
    await q("insert into beo_bar_plans (event_id, service_time, items) values ($1, '14:00', $2)", [
      ev.bar,
      JSON.stringify([
        { id: "b1", itemName: "Cranberry mors", quantity: 2, productCode: "CF-66-4", source: "set_menu" },
        { id: "b2", itemName: "Juice pitcher", quantity: 1, notes: "orange", price: 90 },
        { id: "b3", itemName: "  " },
      ]),
    ]);
    const row = await rowOf(ev.bar);
    assert.deepEqual(row!.kitchen_plan.bar_lines, [
      { line_id: "b1", source: "set_menu", product_code: "CF-66-4", name: "Cranberry mors", qty: 2, note: null, unit_price_satang: null },
      { line_id: "b2", source: "extra", product_code: null, name: "Juice pitcher", qty: 1, note: "orange", unit_price_satang: 9000 },
    ]);
    assert.deepEqual(row!.kitchen_plan.cake, { mode: "INTERNAL", qty: 2, time: "15:30", notes: "chocolate, \"Mali 6\"" });
    assert.equal(row!.kitchen_plan.bar_service_time, "14:00");
    // The column of before keeps its null codes.
    assert.deepEqual(row!.bar_items, [{ product_code: null, name: "Cranberry mors", qty: 2 }, { product_code: null, name: "Juice pitcher", qty: 1 }]);
    await q("update beo_kitchen_plans set cake_mode = 'NONE' where event_id = $1", [ev.bar]);
    assert.equal((await rowOf(ev.bar))!.kitchen_plan.cake, null, "no cake: none");
  });

  await check("decision 8: a party with a kitchen plan and no package has a row whose package names nothing; one with none has no row", async () => {
    await kitchenPlan(ev.bare, { kids: [line("k1", "Nuggets", 8)] }, { setMenu: false });
    const row = await rowOf(ev.bare);
    assert.ok(row, "the party with a kitchen plan and no package");
    assert.equal(row.package.name, null);
    assert.deepEqual(row.package.included_lines, []);
    assert.deepEqual(row.add_ons, []);
    assert.equal(row.kitchen.slips_time, "11:00");
    assert.deepEqual(row.kitchen_plan.lines.map((l: { name: string }) => l.name), ["Nuggets"]);
    assert.equal(await rowOf(ev.none), null, "no package, no kitchen plan, no bar plan: no row, as before");
  });

  await check("the parent's own link, once submitted, shows the choice as the BEO now holds it, after a staff change", async () => {
    const token = `zz-906-link-${run}`;
    await q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted, selections) values ($1, $2, $3, $4, false, null)", [randomUUID(), ev.link, setMenuId, token]);
    await kitchenPlan(ev.link, { kids: [], adults: [] });
    const before = await send("GET", `/api/beo/set-menu-selections/public/${token}`, undefined, false);
    assert.equal(before.status, 200);
    assert.equal(before.body.selections, null, "nothing chosen before the submit");
    const sent = await send("POST", `/api/beo/set-menu-selections/public/${token}/submit`, {
      selections: [{ groupId: RICE, chosenOptions: ["Veggie"] }, { groupId: PIZZA, chosenOptions: ["Margherita"] }],
    }, false);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    let shown = await send("GET", `/api/beo/set-menu-selections/public/${token}`, undefined, false);
    assert.deepEqual(shown.body.selections, [{ groupId: RICE, chosenOptions: ["Veggie"] }, { groupId: PIZZA, chosenOptions: ["Margherita"] }]);
    // Staff change the rice in the BEO and Save, knowing the submission.
    // The submission's time as the editor holds it: from the BEO's own read.
    const opened = await send("GET", `/api/events/${ev.link}/beo`);
    assert.equal(opened.status, 200);
    const submittedAt = opened.body.kitchenPlan.setMenuSelectionStatus.submittedAt;
    assert.ok(submittedAt);
    const [plan] = await q<{ menus: { kids: Line[] } }>("select menus from beo_kitchen_plans where event_id = $1", [ev.link]);
    const kids = plan!.menus.kids.map((l) => (l.groupId === RICE ? { ...l, id: `set_${RICE}_Shrimp`, itemName: "Shrimp" } : l));
    const saved = await send("PUT", `/api/events/${ev.link}/beo`, {
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: true, setMenuTemplateId: setMenuId,
        setMenuSelectionSubmittedAt: submittedAt,
        menus: { kids, adults: [], adultsDiffer: false }, serviceSchedule: [],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    shown = await send("GET", `/api/beo/set-menu-selections/public/${token}`, undefined, false);
    assert.deepEqual(shown.body.selections, [{ groupId: RICE, chosenOptions: ["Shrimp"] }, { groupId: PIZZA, chosenOptions: ["Margherita"] }]);
    assert.equal(shown.body.isSubmitted, true);
    // The till's view reads the same line; the parent's submission row keeps what the parent sent.
    const row = await rowOf(ev.link);
    assert.equal(row!.kitchen_plan.lines[0].chosen_option, "Shrimp");
    const [stored] = await q<{ selections: Array<{ groupId: string; chosenOptions: string[] }> }>("select selections from beo_set_menu_selections where token = $1", [token]);
    assert.deepEqual(stored!.selections[0], { groupId: RICE, chosenOptions: ["Veggie"] });
  });

  console.log(`kitchen-plan-view.check: ${checks} checks passed`);
} finally {
  for (const s of servers) s.close();
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}
process.exit(checks === 7 ? 0 : 1);
