// seed: its own — two ZZ TEST park groups, made here. Not a Playwright file:
// it mounts the directory's kitchen-plan door and the BEO's own routes on a
// bare server and needs a database whose otoapp schema the app's migrator has
// built (0050 included).
//
// SCRUM-907 — a manager changes a party's kitchen plan on the till and the BEO
// is changed (the owner's decision 7 of 12 November), the app's half:
//
//   - the door answers only the platform's tenant-bound directory key with
//     `events:write`: no key 401, a key without the scope or revoked 403,
//     another park group's party 404 (written nothing), not a party 409;
//   - a line's count and note, an extra added (a till item with its code, a
//     typed one with none, a bar line) and removed, a set-menu choice within
//     its group (and an open group chosen), the cake's time and note — each
//     written to the BEO's own rows, and each read back by the till's plan
//     view (otoapp_v.event_packages, 0050) as the till will read it;
//   - the rules of the BEO's Save hold: a set-menu dish is not removed from
//     the till, an option outside its group is refused, a choice of the kids'
//     set menu carries the adults' own copy with it (SCRUM-829), the adults'
//     switch is kept, nothing is priced; a dish of the adults' own in a
//     group (an AI fill's, SCRUM-958) stays, never doubled by a copy;
//   - one till line is every BEO line it shows: with "Different for adults"
//     saved on, a count, a note or a removal of a kids' line carries the
//     adults' copies the view folds into it (a note of the adults' own
//     stays); on a BEO whose adults' list repeats the kids' (saved before the
//     switch), a change of an adults' line is written as the adults' own;
//   - the same edit id twice writes once (one activity row, one line added);
//     the same id with another change is refused `id_in_use`;
//   - the BEO's activity says "changed on the till by <name> (<role>)", in the
//     party's park group and park;
//   - the BEO's own Save still writes the plan as before (it now goes through
//     the same writers).
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> npx tsx tests/till-kitchen-edit.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("till-kitchen-edit.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-907";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const beoRoutes = await import("../server/beo-routes");
const { directoryKitchenPlanRouter } = await import("../server/directory/kitchenPlanRoutes");
const { generateDirectoryKey, hashDirectoryKey } = await import("../server/directory/clientAuth");
const { planTillKitchenEdit } = await import("../server/lib/tillKitchenEdit");
const { db: appDb, pool: appDbPool } = await import("../server/db");

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field below
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; productCode?: string; groupId?: string };
const line = (id: string, itemName: string, quantity = 1, over: Partial<Line> = {}): Line => ({
  id, itemName, quantity, notes: "", included: true, price: 0, ...over,
});

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const other = randomUUID();
const park = randomUUID();
const otherPark = randomUUID();
const manager = randomUUID();
const setMenuId = randomUUID();
const RICE = "item_zz907_rice";
const FRIES = "item_zz907_fries";
const PIZZA = "item_zz907_pizza";
const setMenuItems = [
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, optionProductCodes: { Chicken: "CF-50" }, qty: 3 },
  { id: FRIES, type: "always_included", label: "French fries", productCode: "CF-11", qty: 2 },
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" }, qty: 2 },
];
const ev = {
  main: randomUUID(), adults: randomUUID(), open: randomUUID(), save: randomUUID(), foreign: randomUUID(), camp: randomUUID(),
  foldSet: randomUUID(), foldRemove: randomUUID(), legacy: randomUUID(), ownAdults: randomUUID(),
};
const keys = { a: generateDirectoryKey(), b: generateDirectoryKey(), noScope: generateDirectoryKey(), revoked: generateDirectoryKey() };

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
const timelines: string[] = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
beoRoutes.registerBeoRoutes(app);
app.use(
  directoryKitchenPlanRouter(appDbPool, {
    db: appDb,
    writers: {
      lockKitchenPlanMutation: beoRoutes.lockKitchenPlanMutation,
      kitchenPlanDbDataOf: beoRoutes.kitchenPlanDbDataOf,
      writeKitchenPlanRow: beoRoutes.writeKitchenPlanRow,
      barPlanDbDataOf: beoRoutes.barPlanDbDataOf,
      writeBarPlanRow: beoRoutes.writeBarPlanRow,
    },
    afterWrite: async (eventId) => {
      timelines.push(eventId);
      await beoRoutes.generateTimelineFromBeo(eventId);
    },
  }),
);
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an answer read field by field
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const edit = (eventId: string, changes: unknown[], id: string = randomUUID(), key = keys.a) =>
  send("POST", `/api/directory/events/${eventId}/kitchen-plan`, { id, editedAt: new Date().toISOString(), by: { name: "ZZ Noi", role: "Manager" }, changes }, bearer(key));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a view row read field by field
const rowOf = async (eventId: string) => (await q<Record<string, any>>("select * from otoapp_v.event_packages where event_id = $1", [eventId]))[0] ?? null;
const menusOf = async (eventId: string) => (await q<{ menus: { kids: Line[]; adults: Line[]; adultsDiffer?: boolean } }>("select menus from beo_kitchen_plans where event_id = $1", [eventId]))[0]?.menus;
const barOf = async (eventId: string) => (await q<{ items: Line[]; service_time: string | null }>("select items, service_time from beo_bar_plans where event_id = $1", [eventId]))[0];
const activitiesOf = async (eventId: string) =>
  q<{ summary_text: string; tenant_id: string; branch_id: string; metadata_json: string; created_by: string | null }>(
    "select summary_text, tenant_id, branch_id, metadata_json, created_by from activity_log where activity_type = 'beo_kitchen_plan_till_edit' and metadata_json like $1",
    [`%"eventId":"${eventId}"%`],
  );
const kitchenPlan = async (id: string, menus: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  q(
    `insert into beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus, cake_mode, cake_quantity, cake_time, cake_notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(), id, over.setMenu ?? true, (over.setMenu ?? true) ? setMenuId : null, JSON.stringify(menus),
      over.cakeMode ?? "NONE", over.cakeQuantity ?? 1, over.cakeTime ?? null, over.cakeNotes ?? null,
    ],
  );
const resolved = (rice: string, pizza: string): Line[] => [
  line(`set_${RICE}_${rice}`, rice, 3, { notes: "(Fried rice)", source: "set_menu", groupId: RICE }),
  line(`set_${FRIES}`, "French fries", 2, { source: "set_menu", groupId: FRIES }),
  line(`set_${PIZZA}_${pizza}`, pizza, 2, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA }),
];

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3), ($4, $5, $6)", [
    tenant, `ZZ TEST 907 ${run}`, `zz-907-${run}`, other, `ZZ TEST 907 other ${run}`, `zz-907-other-${run}`,
  ]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST 907 park', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, randomUUID()]);
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, 'ZZ TEST 907 other park', 'ZZ TEST', 'Asia/Bangkok')", [otherPark, other]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 907', 'manager', true, false)", [manager, `zz-907-${run}@example.com`]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'ZZ TEST 907 set menu', $3)", [setMenuId, tenant, JSON.stringify(setMenuItems)]);
  for (const [name, id] of Object.entries(ev)) {
    const foreign = name === "foreign";
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
       values ($1, $2, $3, $4, $5, '2099-04-18', '13:00', '16:00', 10, 4, 'upcoming')`,
      [id, foreign ? other : tenant, foreign ? otherPark : park, name === "camp" ? "camp" : "birthday", `ZZ TEST 907 ${name} ${run}`],
    );
    await q("insert into beo_package_snapshots (id, event_id, package_name, base_price) values ($1, $2, 'ZZ TEST package', 1690000)", [randomUUID(), id]);
  }
  const client = (tenantId: string, key: string, scopes: string[], revoked = false) =>
    q(`insert into directory_clients (tenant_id, name, key_hash, scopes, is_active, revoked_at) values ($1, $2, $3, $4, true, $5)`, [
      tenantId, `ZZ TEST 907 ${run} ${scopes.join("+")}`, hashDirectoryKey(key), scopes, revoked ? new Date() : null,
    ]);
  await client(tenant, keys.a, ["events:write"]);
  await client(other, keys.b, ["events:write"]);
  await client(tenant, keys.noScope, ["hr:read"]);
  await client(tenant, keys.revoked, ["events:write"], true);

  await kitchenPlan(
    ev.main,
    {
      kidsFoodTime: "14:00",
      kids: [
        ...resolved("Veggie", "Margherita"),
        line("m1", "Calamari", 2, { included: false, price: 120, productCode: "CF-14", source: "additional" }),
        line("m2", "ZZ fruit plate", 1, { included: false, source: "additional" }),
      ],
      adults: [],
      adultsDiffer: false,
    },
    { cakeMode: "INTERNAL", cakeQuantity: 1, cakeTime: "15:00", cakeNotes: "ZZ unicorn" },
  );
  await q("insert into beo_bar_plans (event_id, service_time, items) values ($1, '19:15', $2)", [
    ev.main,
    JSON.stringify([{ id: "b1", itemName: "Mineral water", quantity: 2, productCode: "CF-65-6", notes: "", source: "additional", price: 0, included: false }]),
  ]);

  await check("only the platform's events:write key for the party's own park group; another park group's party is not found", async () => {
    const body = { id: randomUUID(), editedAt: new Date().toISOString(), by: { name: "ZZ Noi", role: "Manager" }, changes: [{ op: "set", lineId: "m1", qty: 5 }] };
    assert.equal((await send("POST", `/api/directory/events/${ev.main}/kitchen-plan`, body)).status, 401, "no key");
    assert.equal((await send("POST", `/api/directory/events/${ev.main}/kitchen-plan`, body, bearer(keys.noScope))).status, 403, "no scope");
    assert.equal((await send("POST", `/api/directory/events/${ev.main}/kitchen-plan`, body, bearer(keys.revoked))).status, 403, "revoked");
    assert.equal((await send("POST", `/api/directory/events/${ev.main}/kitchen-plan`, body, bearer(keys.b))).status, 404, "another park group's key");
    assert.equal((await send("POST", `/api/directory/events/${ev.foreign}/kitchen-plan`, body, bearer(keys.a))).status, 404, "another park group's party");
    assert.equal((await send("POST", `/api/directory/events/${randomUUID()}/kitchen-plan`, body, bearer(keys.a))).status, 404, "a party it does not know");
    const camp = await send("POST", `/api/directory/events/${ev.camp}/kitchen-plan`, body, bearer(keys.a));
    assert.equal(camp.status, 409);
    assert.equal(camp.body.error, "not_a_party");
    assert.equal((await send("POST", `/api/directory/events/${ev.main}/kitchen-plan`, { ...body, changes: [{ op: "set", lineId: "m1", qty: 0 }] }, bearer(keys.a))).status, 400, "a count of 0");
    assert.equal((await send("POST", `/api/directory/events/${ev.main}/kitchen-plan`, { ...body, changes: [{ op: "set", lineId: "m1", qty: 1_000_000 }] }, bearer(keys.a))).status, 400, "past the bound");
    assert.equal((await send("POST", `/api/directory/events/${ev.main}/kitchen-plan`, { ...body, changes: [{ op: "add", id: randomUUID(), list: "food", name: "x", productCode: null, qty: 1, price: 90 }] }, bearer(keys.a))).status, 400, "a price is never taken");
    assert.equal((await menusOf(ev.main))!.kids.find((l) => l.id === "m1")!.quantity, 2, "nothing written");
    assert.equal((await activitiesOf(ev.main)).length, 0);
  });

  await check("a count, a note, an added till item, a typed line, a bar line, a removed extra: the BEO's rows and the till's view", async () => {
    const id = randomUUID();
    const added = randomUUID();
    const typed = randomUUID();
    const drink = randomUUID();
    const res = await edit(ev.main, [
      { op: "set", lineId: "m1", qty: 3, note: "no sauce" },
      { op: "add", id: added, list: "food", name: "Hummus", productCode: "CF-13", qty: 1 },
      { op: "add", id: typed, list: "food", name: "ZZ mango sticky rice", productCode: null, qty: 2, note: "no nuts" },
      { op: "add", id: drink, list: "bar", name: "Kids juice Apple", productCode: "CF-66-1", qty: 4 },
      { op: "remove", lineId: "m2" },
      { op: "set", lineId: "b1", qty: 3 },
    ], id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { edit: { id, eventId: ev.main, changes: 6 }, replayed: false });
    const menus = await menusOf(ev.main);
    assert.deepEqual(menus!.kids.find((l) => l.id === "m1"), line("m1", "Calamari", 3, { included: false, price: 120, productCode: "CF-14", source: "additional", notes: "no sauce" }));
    assert.equal(menus!.kids.some((l) => l.id === "m2"), false, "the extra is removed");
    assert.deepEqual(menus!.kids.find((l) => l.id === `till_${added}`), {
      id: `till_${added}`, itemName: "Hummus", quantity: 1, notes: "", included: false, price: 0, source: "additional", productCode: "CF-13",
    });
    assert.deepEqual(menus!.adults, [], "the adults eat the kids' list: none kept for them");
    assert.equal(menus!.adultsDiffer, false);
    const bar = await barOf(ev.main);
    assert.equal(bar!.service_time, "19:15");
    assert.deepEqual(bar!.items.map((l) => [l.id, l.itemName, l.quantity, l.productCode ?? null, l.price]), [
      ["b1", "Mineral water", 3, "CF-65-6", 0],
      [`till_${drink}`, "Kids juice Apple", 4, "CF-66-1", 0],
    ]);
    // The till's plan view reads it as the till will.
    const row = await rowOf(ev.main);
    const lines = row!.kitchen_plan.lines.filter((l: { source: string }) => l.source === "extra");
    assert.deepEqual(lines.map((l: Record<string, unknown>) => [l.line_id, l.name, l.qty, l.product_code, l.note, l.unit_price_satang]), [
      ["m1", "Calamari", 3, "CF-14", "no sauce", 12_000],
      [`till_${added}`, "Hummus", 1, "CF-13", null, null],
      [`till_${typed}`, "ZZ mango sticky rice", 2, null, "no nuts", null],
    ]);
    assert.deepEqual(row!.kitchen_plan.bar_lines.map((l: Record<string, unknown>) => [l.line_id, l.qty]), [["b1", 3], [`till_${drink}`, 4]]);
    // The BEO's activity says who, on the till, in the party's park group and park.
    const acts = await activitiesOf(ev.main);
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!.tenant_id, tenant);
    assert.equal(acts[0]!.branch_id, park);
    assert.equal(acts[0]!.created_by, null);
    assert.match(acts[0]!.summary_text, /^Kitchen plan of "ZZ TEST 907 main .+" changed on the till by ZZ Noi \(Manager\): /);
    assert.match(acts[0]!.summary_text, /Calamari ×2 → ×3, note "no sauce"; added Hummus ×1 \(CF-13\); .*removed ZZ fruit plate/);
    assert.equal(JSON.parse(acts[0]!.metadata_json).tillEditId, id);
    assert.ok(timelines.includes(ev.main), "the BEO's timeline follows its plan, as after the Save");
  });

  await check("the same edit id twice writes once; the same id with another change is refused", async () => {
    const id = randomUUID();
    const added = randomUUID();
    const changes = [{ op: "add", id: added, list: "food", name: "French fries", productCode: "CF-11", qty: 2 }];
    const [a, b] = await Promise.all([edit(ev.main, changes, id), edit(ev.main, changes, id)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual([a.body.replayed, b.body.replayed].sort(), [false, true]);
    const again = await edit(ev.main, changes, id);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal((await menusOf(ev.main))!.kids.filter((l) => l.id === `till_${added}`).length, 1, "one line");
    assert.equal((await activitiesOf(ev.main)).filter((a2) => JSON.parse(a2.metadata_json).tillEditId === id).length, 1, "one activity row");
    const other2 = await edit(ev.main, [{ op: "set", lineId: "m1", qty: 9 }], id);
    assert.equal(other2.status, 409);
    assert.equal(other2.body.error, "id_in_use");
    assert.equal((await menusOf(ev.main))!.kids.find((l) => l.id === "m1")!.quantity, 3);
  });

  await check("a set-menu choice within its group, with the template's code; an option outside it, a dish removed, a gone line: refused in words", async () => {
    const res = await edit(ev.main, [{ op: "choose", choiceGroup: "Fried rice", lineId: `set_${RICE}_Veggie`, option: "Chicken" }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rice = (await menusOf(ev.main))!.kids.find((l) => l.groupId === RICE)!;
    assert.deepEqual([rice.id, rice.itemName, rice.quantity, rice.notes, rice.source, rice.productCode ?? null], [`set_${RICE}_Veggie`, "Chicken", 3, "(Fried rice)", "set_menu", null]);
    const row = await rowOf(ev.main);
    const viewed = row!.kitchen_plan.lines.find((l: { choice_group: string | null }) => l.choice_group === "Fried rice");
    assert.deepEqual([viewed.chosen_option, viewed.product_code, viewed.qty], ["Chicken", "CF-50", 3]);
    const outside = await edit(ev.main, [{ op: "choose", choiceGroup: "Fried rice", lineId: `set_${RICE}_Veggie`, option: "Margherita" }]);
    assert.equal(outside.status, 400);
    assert.equal(outside.body.error, "option_not_in_group");
    assert.match(outside.body.message, /not one of the choices for Fried rice: Veggie, Chicken, Shrimp/);
    const dish = await edit(ev.main, [{ op: "remove", lineId: `set_${FRIES}` }]);
    assert.equal(dish.status, 409);
    assert.equal(dish.body.error, "set_menu_line");
    const goneLine = await edit(ev.main, [{ op: "set", lineId: "m2", qty: 2 }]);
    assert.equal(goneLine.status, 409);
    assert.equal(goneLine.body.error, "line_not_found");
    // A refused edit writes nothing, all or none: the first change of a refused list is not kept.
    const half = await edit(ev.main, [{ op: "set", lineId: "m1", qty: 7 }, { op: "remove", lineId: `set_${FRIES}` }]);
    assert.equal(half.status, 409);
    assert.equal((await menusOf(ev.main))!.kids.find((l) => l.id === "m1")!.quantity, 3);
  });

  await check("the cake's time and note; a party with no cake is told so", async () => {
    const res = await edit(ev.main, [{ op: "cake", time: "16:30", note: "ZZ rainbow" }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [kp] = await q<{ cake_time: string; cake_notes: string; cake_mode: string; cake_quantity: number }>("select cake_time, cake_notes, cake_mode, cake_quantity from beo_kitchen_plans where event_id = $1", [ev.main]);
    assert.deepEqual(kp, { cake_time: "16:30", cake_notes: "ZZ rainbow", cake_mode: "INTERNAL", cake_quantity: 1 });
    assert.deepEqual((await rowOf(ev.main))!.kitchen_plan.cake, { mode: "INTERNAL", qty: 1, time: "16:30", notes: "ZZ rainbow" });
    await kitchenPlan(ev.open, { kids: [], adults: [] });
    const none = await edit(ev.open, [{ op: "cake", time: "16:30" }]);
    assert.equal(none.status, 409);
    assert.equal(none.body.error, "no_cake");
  });

  await check("an open group chosen on the till as the parent's submit would; the choices door names the groups", async () => {
    const res = await edit(ev.open, [{ op: "choose", choiceGroup: "Pizza", lineId: null, option: "Hawaiian" }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const kids = (await menusOf(ev.open))!.kids;
    assert.deepEqual(kids, [line(`set_${PIZZA}_Hawaiian`, "Hawaiian", 2, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA })]);
    const pizza = (await rowOf(ev.open))!.kitchen_plan.lines.find((l: { choice_group: string | null }) => l.choice_group === "Pizza");
    assert.deepEqual([pizza.chosen_option, pizza.product_code, pizza.qty], ["Hawaiian", "CF-27", 2]);
    const again = await edit(ev.open, [{ op: "choose", choiceGroup: "Pizza", lineId: null, option: "Margherita" }]);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "choice_already_made");
    const choices = await send("GET", `/api/directory/events/${ev.open}/kitchen-plan/choices`, undefined, bearer(keys.a));
    assert.equal(choices.status, 200);
    assert.deepEqual(choices.body, {
      setMenu: {
        templateName: "ZZ TEST 907 set menu",
        groups: [
          { label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false },
          { label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false },
        ],
      },
    });
    assert.equal((await send("GET", `/api/directory/events/${ev.open}/kitchen-plan/choices`, undefined, bearer(keys.b))).status, 404);
    assert.equal((await send("GET", `/api/directory/events/${ev.open}/kitchen-plan/choices`)).status, 401);
  });

  await check("SCRUM-829: with the adults' own list, a kids' choice carries the adults' copy; the switch is kept", async () => {
    const kids = resolved("Veggie", "Margherita");
    await kitchenPlan(ev.adults, { kids, adults: [line(`set_${RICE}_Veggie_adults`, "Veggie", 3, { notes: "(Fried rice)", source: "set_menu", groupId: RICE }), line("a1", "Steak", 4, { source: "additional" })], adultsDiffer: true });
    const res = await edit(ev.adults, [{ op: "choose", choiceGroup: "Fried rice", lineId: `set_${RICE}_Veggie`, option: "Shrimp" }, { op: "set", lineId: "a1", qty: 5 }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const menus = await menusOf(ev.adults);
    assert.equal(menus!.adultsDiffer, true);
    assert.deepEqual(menus!.adults.map((l) => [l.id, l.itemName, l.quantity]), [[`set_${RICE}_Veggie_adults`, "Shrimp", 3], ["a1", "Steak", 5]]);
    assert.equal(menus!.kids.find((l) => l.groupId === RICE)!.itemName, "Shrimp");
  });

  await check("SCRUM-958: a dish of the adults' own in a set-menu group stays: a kids' choice moves only its copy, an open group adds none", async () => {
    // As an AI fill's approval writes "chicken fried rice for the adults" beside the kids' Margherita,
    // the kids' Fried rice not chosen yet: the kids' set menu copied for the adults, and their own Chicken.
    const kidsPizza = line(`set_${PIZZA}_Margherita`, "Margherita", 2, { notes: "(Pizza)", source: "set_menu", groupId: PIZZA });
    const kidsFries = line(`set_${FRIES}`, "French fries", 2, { source: "set_menu", groupId: FRIES });
    const ownRice = line(`set_${RICE}_Chicken_adults`, "Chicken", 3, { notes: "(Fried rice)", source: "set_menu", groupId: RICE });
    await kitchenPlan(ev.ownAdults, {
      kids: [kidsPizza, kidsFries],
      adults: [{ ...kidsPizza, id: `${kidsPizza.id}_adults` }, { ...kidsFries, id: `${kidsFries.id}_adults` }, ownRice],
      adultsDiffer: true,
    });
    const riceOf = (lines: Line[]) => lines.filter((l) => l.groupId === RICE).map((l) => [l.id, l.itemName]);
    // The kids' open Fried rice chosen on the till: the kids get it; the adults keep their own Chicken, no copy.
    const open = await edit(ev.ownAdults, [{ op: "choose", choiceGroup: "Fried rice", lineId: null, option: "Veggie" }]);
    assert.equal(open.status, 200, JSON.stringify(open.body));
    let menus = await menusOf(ev.ownAdults);
    assert.deepEqual(riceOf(menus!.kids), [[`set_${RICE}_Veggie`, "Veggie"]]);
    assert.deepEqual(riceOf(menus!.adults), [[`set_${RICE}_Chicken_adults`, "Chicken"]], "one Fried rice for the adults: their own");
    // The kids' choice changed again on the till: the adults' own Chicken stays.
    const again = await edit(ev.ownAdults, [{ op: "choose", choiceGroup: "Fried rice", lineId: `set_${RICE}_Veggie`, option: "Shrimp" }]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    menus = await menusOf(ev.ownAdults);
    assert.deepEqual(riceOf(menus!.kids), [[`set_${RICE}_Veggie`, "Shrimp"]]);
    assert.deepEqual(riceOf(menus!.adults), [[`set_${RICE}_Chicken_adults`, "Chicken"]]);
    // The kids' pizza changed: its adults' copy follows, as before (SCRUM-829).
    const pizza = await edit(ev.ownAdults, [{ op: "choose", choiceGroup: "Pizza", lineId: kidsPizza.id, option: "Hawaiian" }]);
    assert.equal(pizza.status, 200, JSON.stringify(pizza.body));
    menus = await menusOf(ev.ownAdults);
    assert.deepEqual(menus!.adults.map((l) => l.itemName), ["Hawaiian", "French fries", "Chicken"]);
    assert.equal(menus!.adultsDiffer, true);
    // The till: the kids' Shrimp is the kids' only, the adults' Chicken theirs; one Fried rice each.
    const rice = ((await rowOf(ev.ownAdults))!.kitchen_plan.lines as Record<string, unknown>[])
      .filter((l) => String(l.line_id).startsWith(`set_${RICE}`))
      .map((l) => [l.line_id, l.chosen_option ?? l.name, l.audience ?? null]);
    assert.deepEqual(rice, [[`set_${RICE}_Veggie`, "Shrimp", "kids"], [`set_${RICE}_Chicken_adults`, "Chicken", "adults"]]);
  });

  // The till's food lines as the plan view hands them: id, dish, count, note and 0048's marks.
  const viewLinesOf = async (eventId: string) =>
    ((await rowOf(eventId))!.kitchen_plan.lines as Record<string, unknown>[]).map((l) => [
      l.line_id, l.name, l.qty, l.note ?? null, l.audience ?? null, l.adults_note ?? null,
    ]);
  const calamari = (id: string, quantity = 2, over: Partial<Line> = {}) =>
    line(id, "Calamari", quantity, { included: false, price: 120, productCode: "CF-14", source: "additional", ...over });

  await check("adults' switch on: a kids' line's count and note carry the adults' copies the till shows with it", async () => {
    await kitchenPlan(
      ev.foldSet,
      {
        kids: [calamari("k1"), line("k2", "Hummus", 1, { included: false, productCode: "CF-13", source: "additional" })],
        // As the editor's switch makes them: a copy of each kids' line, the Hummus with an adults' own note, and a steak.
        adults: [
          calamari("menu_copy_0"),
          line("menu_copy_1", "Hummus", 1, { included: false, productCode: "CF-13", source: "additional", notes: "no garlic" }),
          line("a1", "Steak", 4, { included: false, source: "additional" }),
        ],
        adultsDiffer: true,
      },
      { setMenu: false },
    );
    // The till shows each dish once: the Calamari and the Hummus with their copies folded in.
    assert.deepEqual(await viewLinesOf(ev.foldSet), [
      ["k1", "Calamari", 2, null, null, null],
      ["k2", "Hummus", 1, null, null, "no garlic"],
      ["a1", "Steak", 4, null, "adults", null],
    ]);
    const res = await edit(ev.foldSet, [
      { op: "set", lineId: "k1", qty: 3, note: "no sauce" },
      { op: "set", lineId: "k2", qty: 2, note: "warm" },
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const menus = await menusOf(ev.foldSet);
    assert.equal(menus!.adultsDiffer, true);
    assert.deepEqual(menus!.kids.map((l) => [l.id, l.quantity, l.notes]), [["k1", 3, "no sauce"], ["k2", 2, "warm"]]);
    assert.deepEqual(menus!.adults.map((l) => [l.id, l.quantity, l.notes]), [
      ["menu_copy_0", 3, "no sauce"],
      ["menu_copy_1", 2, "no garlic"],
      ["a1", 4, ""],
    ]);
    // Still one line each on the till: the kitchen makes 3 Calamari, not 3 and 2.
    assert.deepEqual(await viewLinesOf(ev.foldSet), [
      ["k1", "Calamari", 3, "no sauce", null, null],
      ["k2", "Hummus", 2, "warm", null, "no garlic"],
      ["a1", "Steak", 4, null, "adults", null],
    ]);
    const acts = await activitiesOf(ev.foldSet);
    assert.equal(acts.length, 1);
    assert.match(acts[0]!.summary_text, /Calamari ×2 → ×3, note "no sauce" \(the adults' too\); Hummus ×1 → ×2, note "warm" \(the adults' too\)$/);
  });

  await check("adults' switch on: removing a kids' extra removes the adults' copy the till shows with it", async () => {
    await kitchenPlan(
      ev.foldRemove,
      { kids: [calamari("k1")], adults: [calamari("menu_copy_0"), line("a1", "Steak", 4, { included: false, source: "additional" })], adultsDiffer: true },
      { setMenu: false },
    );
    assert.deepEqual(await viewLinesOf(ev.foldRemove), [["k1", "Calamari", 2, null, null, null], ["a1", "Steak", 4, null, "adults", null]]);
    const res = await edit(ev.foldRemove, [{ op: "remove", lineId: "k1" }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const menus = await menusOf(ev.foldRemove);
    assert.deepEqual(menus!.kids, []);
    assert.deepEqual(menus!.adults.map((l) => l.id), ["a1"]);
    assert.equal(menus!.adultsDiffer, true);
    // No "Calamari ×2 · adults" left on the slip or the bill.
    assert.deepEqual(await viewLinesOf(ev.foldRemove), [["a1", "Steak", 4, null, "adults", null]]);
    assert.match((await activitiesOf(ev.foldRemove))[0]!.summary_text, /removed Calamari \(the adults' too\)$/);
  });

  await check("a BEO saved before the switch, its adults' list repeating the kids': an adults' line's change is written as theirs", async () => {
    // No adultsDiffer key: the till shows the two lists' lines apart (0048's reading of such a BEO).
    await kitchenPlan(ev.legacy, { kids: [calamari("k1")], adults: [calamari("a1")] }, { setMenu: false });
    assert.deepEqual(await viewLinesOf(ev.legacy), [["k1", "Calamari", 2, null, null, null], ["a1", "Calamari", 2, null, null, null]]);
    const res = await edit(ev.legacy, [{ op: "set", lineId: "a1", qty: 5, note: "adults spicy" }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const menus = await menusOf(ev.legacy);
    assert.equal(menus!.adultsDiffer, true, "the adults' list is now their own");
    assert.deepEqual(menus!.kids.map((l) => [l.id, l.quantity, l.notes]), [["k1", 2, ""]]);
    assert.deepEqual(menus!.adults.map((l) => [l.id, l.quantity, l.notes]), [["a1", 5, "adults spicy"]]);
    assert.deepEqual(await viewLinesOf(ev.legacy), [["k1", "Calamari", 2, null, null, null], ["a1", "Calamari", 5, "adults spicy", "adults", null]]);
    assert.match((await activitiesOf(ev.legacy))[0]!.summary_text, /Calamari ×2 → ×5, note "adults spicy"$/);

    // The planner alone: a change of the kids' list only writes the BEO Save's own form (the adults
    // eat the kids' list); with the switch never saved, the till showed the lists apart, so no copy moves.
    const legacy = (adults: Line[], adultsDiffer?: boolean) => ({
      kitchen: { setMenuEnabled: false, cakeMode: "NONE", menus: { kids: [calamari("k1")], adults, ...(adultsDiffer === undefined ? {} : { adultsDiffer }) } },
      bar: null,
      template: null,
    });
    const kidsOnly = planTillKitchenEdit(legacy([calamari("a1")]), [{ op: "set", lineId: "k1", qty: 3 }]);
    assert.ok(kidsOnly.ok && kidsOnly.kitchen);
    if (!kidsOnly.ok || !kidsOnly.kitchen) return;
    assert.deepEqual([kidsOnly.kitchen.menus.adults, kidsOnly.kitchen.menus.adultsDiffer], [[], false]);
    const unsaved = planTillKitchenEdit(legacy([calamari("a1"), line("a2", "Steak", 4)]), [{ op: "set", lineId: "k1", qty: 3 }]);
    assert.ok(unsaved.ok && unsaved.kitchen);
    if (!unsaved.ok || !unsaved.kitchen) return;
    assert.deepEqual(unsaved.kitchen.menus.adults.map((l: Line) => [l.id, l.quantity]), [["a1", 2], ["a2", 4]]);
    assert.equal(unsaved.kitchen.menus.adultsDiffer, true);
  });

  await check("the planner alone: a legacy line keeps its group when its note changes; nothing is priced", () => {
    const planned = planTillKitchenEdit(
      {
        kitchen: { setMenuEnabled: true, setMenuTemplateId: setMenuId, cakeMode: "NONE", menus: { kids: [line("old", "Shrimp", 3, { notes: "(Fried rice)", source: "set_menu" })], adults: [] } },
        bar: null,
        template: { name: "t", items: setMenuItems },
      },
      [{ op: "set", lineId: "old", note: "extra crispy" }],
    );
    assert.ok(planned.ok);
    if (!planned.ok) return;
    assert.deepEqual(planned.kitchen!.menus.kids[0], line("old", "Shrimp", 3, { notes: "extra crispy", source: "set_menu", groupId: RICE }));
    assert.equal(planned.bar, null, "the bar is not written when no bar line changed");
  });

  await check("the BEO's own Save writes the kitchen and bar plans as before, through the same writers", async () => {
    await kitchenPlan(ev.save, { kids: [line("k1", "Nuggets", 8)], adults: [] }, { setMenu: false });
    const saved = await send("PUT", `/api/events/${ev.save}/beo`, {
      kitchenPlan: { foodRequired: true, cakeMode: "EXTERNAL", cakeTime: "15:45", cakeNotes: "ZZ own", setMenuEnabled: false, setMenuTemplateId: null, menus: { kids: [line("k1", "Nuggets", 9)], adults: [], adultsDiffer: false, kidsFoodTime: "14:30" }, serviceSchedule: [] },
      barPlan: { serviceTime: "18:00", items: [{ id: "bb", itemName: "Lemonade", quantity: 2, notes: "", included: false, price: 0 }] },
    }, { "x-test-as": "manager" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const row = await rowOf(ev.save);
    assert.deepEqual(row!.kitchen_plan.lines.map((l: Record<string, unknown>) => [l.line_id, l.name, l.qty]), [["k1", "Nuggets", 9]]);
    assert.deepEqual(row!.kitchen_plan.cake, { mode: "EXTERNAL", qty: 1, time: "15:45", notes: "ZZ own" });
    assert.equal(row!.kitchen_plan.bar_service_time, "18:00");
    assert.deepEqual(row!.kitchen_plan.bar_lines.map((l: Record<string, unknown>) => [l.line_id, l.name, l.qty]), [["bb", "Lemonade", 2]]);
    assert.equal(row!.kitchen.kids_food_time, "14:30");
  });

  console.log(`till-kitchen-edit.check: ${checks} checks passed`);
} finally {
  for (const s of servers) s.close();
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}
process.exit(checks === 13 ? 0 : 1);
