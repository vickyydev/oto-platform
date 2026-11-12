// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub inbox) and needs a database whose
// otoapp schema the app's migrator has built. It renders the review's own
// component, so it runs with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-946 (the corrections from the Phase B staging proof of 12 November,
// SCRUM-904) — what the review shows is what Approve and create writes:
//   1. an extra order for the adults ("3 more Margherita pizzas for the
//      adults") is the adults' own list, written with the switch on; a list
//      that only repeats the kids' menu stays a mirror; the count is what was
//      written.
//
// Every model answer here is scripted: no model key is used.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-fill-corrections.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-fill-corrections.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-946";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "info";

const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const { loadBeoCatalogue } = await import("../server/lib/beoCatalogueFill");
const { db, pool: appDbPool } = await import("../server/db");
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type BeoAiApproveBody = import("../shared/beoAiFill").BeoAiApproveBody;

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, any>>(text: string, params: unknown[] = []) => (await pool.query<T>(text, params)).rows;
const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results[name] = true;
  } catch (error) {
    results[name] = false;
    failures[name] = error instanceof Error ? `${error.message}\n${error.stack?.split("\n").slice(1, 4).join("\n")}` : String(error);
  }
}
const CHECKS = 1;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
/** The park's till branch (`branches.core_branch_id`): the till's plan view and the till's menu are keyed by it. */
const coreBranch = randomUUID();
const manager = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID(), otherMenu: randomUUID(), bubble: randomUUID() };
const KEYS = ["extra", "mirror"] as const;
type Key = (typeof KEYS)[number];
const ev = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const conv = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const PIZZA = "item_946_pizza";
const RICE = "item_946_fried_rice";
const FRIES = "item_946_fries";
const STICKS = "item_946_sticks";
const BOOKED = "2099-12-20";

// The park's set menu as staging has it: a pizza group whose options carry their own codes, a
// fried-rice group whose options share one code, two dishes always included.
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" } },
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, productCode: "CF-43", optionProductCodes: {} },
  { id: FRIES, type: "always_included", label: "French fries", productCode: "CF-11" },
  { id: STICKS, type: "always_included", label: "Veggie sticks", productCode: "CF-53" },
];
// Another set menu of the park group naming the same codes otherwise (SCRUM-946 point 5).
const otherMenuItems = [
  { id: "item_946_other_rice", type: "always_included", label: "Fried Rice", productCode: "CF-43" },
  { id: "item_946_other_pizza", type: "always_included", label: "Margherita Pizza", productCode: "CF-24" },
];

const modelCalls: AiCompleteOptions[] = [];
const answers = new Map<string, unknown>();
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    for (const [mark, answer] of answers) if (call.user.includes(mark) && call.system.includes("THE CONVERSATION")) return JSON.stringify(answer);
    return JSON.stringify({ summary: "ZZ plain" });
  },
};
const at = (i: number) => new Date(Date.UTC(2026, 10, 12, 7, i * 7)).toISOString();
type TLine = { id: string; author: "customer" | "staff"; at: string; text: string };
const chats = new Map<string, TLine[]>();
const inboxOf = (key: Key): InboxRead => ({
  ok: true,
  confirmation: { conversationId: conv[key], eventId: ev[key], message: null, scanned: chats.get(key)?.length ?? 0, transcript: chats.get(key) ?? [], transcriptCut: false },
});

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  if (req.get("x-test-as") !== "manager") return res.status(401).json({ message: "Not signed in" });
  (req as any).isAuthenticated = () => true;
  (req as any).user = { id: manager, tenantId: tenant, role: "manager" };
  (req as any).userWithAccess = { id: manager, tenantId: tenant, isActive: true, role: "manager", hasAllBranchesAccess: false, allowedBranchIds: [park] };
  next();
}

const servers: Server[] = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
registerAIRoutes(app, fakeAuth, {
  ai,
  readSetting: async () => null,
  inboxConfirmation: async (_req, conversationId) => {
    const key = KEYS.find((k) => conv[k] === conversationId);
    return key ? inboxOf(key) : { ok: false, reason: "inbox_unreachable" };
  },
  catalogue: async (event) => loadBeoCatalogue(db, { tenantId: event.tenantId, branchId: event.branchId }),
});
registerBeoRoutes(app);
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-test-as": "manager" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const approve = (eventId: string, body: unknown) => post(`/api/events/${eventId}/beo/ai-fill/approve`, body);
const bodyOf = (over: Partial<BeoAiApproveBody>): BeoAiApproveBody => ({
  conversationId: null, messageId: null, package: null, setMenu: null, menuLines: [], entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [], ...over,
});
const kitchenOf = async (eventId: string) => (await q("select * from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null;
const viewLinesOf = async (eventId: string) =>
  ((await q<{ kitchen_plan: { lines: Array<Record<string, any>> } }>("select kitchen_plan from otoapp_v.event_packages where event_id = $1", [eventId]))[0]?.kitchen_plan?.lines ?? []);

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 946 ${run}`, `zz-946-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST Central Floresta 946', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, coreBranch]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 946', 'manager', true, false)", [
    manager, `zz-946-${manager.slice(0, 8)}@example.com`,
  ]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items, created_at) values ($1, $2, 'Birthday set menu 946', $3, now() - interval '1 minute')", [cat.setMenu, tenant, JSON.stringify(setMenuItems)]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Another set menu 946', $3)", [cat.otherMenu, tenant, JSON.stringify(otherMenuItems)]);
  await q(
    `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours,
       price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, set_menu_template_id, branch_id, sort_order)
     values ($1, $2, 'Birthday package 946', 1690000, 10, 4, -1, 3, 1690000, 2090000, 130000, 150000, $3, $4, 1)`,
    [cat.pkg, tenant, cat.setMenu, park],
  );
  await q(
    `insert into entertainment_package_templates (id, tenant_id, name, category, duration_minutes, default_price, billable_by_default, unit, sort_order)
     values ($1, $2, 'Bubble show', 'Shows', 30, 550000, true, 'session', 1)`,
    [cat.bubble, tenant],
  );
  for (const key of KEYS) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, status, inbox_conversation_id, num_children, num_adults)
       values ($1, $2, $3, 'birthday', $4, $5, '15:00', '17:30', 'tentative', $6, 14, 10)`,
      [ev[key], tenant, park, `ZZ TEST 946 ${key}`, BOOKED, conv[key]],
    );
  }

  // --- 1. The adults' extra order ------------------------------------------------------------
  await check("anExtraOrderForTheAdultsIsWritten", async () => {
    // The proof's thread D: the set menu's Margherita, 2 more for the kids, 3 more for the adults.
    const res = await approve(ev.extra, bodyOf({
      setMenu: { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Margherita"] }] },
      menuLines: [
        { menu: "kids", itemName: "2 more Margherita pizzas for the kids on the side", quantity: 2, productCode: "CF-24", notes: null, option: "Margherita" },
        { menu: "adults", itemName: "3 more Margherita pizzas for the adults", quantity: 3, productCode: "CF-24", notes: null, option: "Margherita" },
      ],
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.written.kitchenLines, 2, "both lines written, both counted");
    assert.equal(res.body.written.adultsLinesFolded, undefined);
    const plan = await kitchenOf(ev.extra);
    assert.equal(plan.menus.adultsDiffer, true, "the adults' own order: the switch on");
    const adults = (plan.menus.adults as any[]).map((l) => [l.itemName, l.quantity, l.source]);
    assert.deepEqual(adults, [
      ["Margherita", 1, "set_menu"], ["French fries", 1, "set_menu"], ["Veggie sticks", 1, "set_menu"], ["Margherita", 3, "additional"],
    ], "the set menu's copies, then the 3 the review showed");
    assert.deepEqual((plan.menus.kids as any[]).filter((l) => l.source !== "set_menu").map((l) => [l.itemName, l.quantity]), [["Margherita", 2]]);
    // The till's plan: the kids' 2 and the adults' 3, the adults' marked as theirs.
    const lines = (await viewLinesOf(ev.extra)).filter((l) => l.source === "extra");
    assert.deepEqual(lines.map((l) => [l.name, l.qty, l.audience ?? null]), [["Margherita", 2, null], ["Margherita", 3, "adults"]], JSON.stringify(lines));

    // A real mirror stays a mirror: the adults' lines naming the kids' whole menu again and nothing else.
    const mirror = await approve(ev.mirror, bodyOf({
      menuLines: [
        { menu: "kids", itemName: "Nuggets", quantity: 14, productCode: null, notes: null },
        { menu: "kids", itemName: "Fries", quantity: 14, productCode: null, notes: null },
        { menu: "adults", itemName: "nuggets", quantity: 10, productCode: null, notes: "adults eat the same as the kids" },
        { menu: "adults", itemName: "Fries", quantity: 10, productCode: null, notes: null },
      ],
    }));
    assert.equal(mirror.status, 200, JSON.stringify(mirror.body));
    const mirrored = await kitchenOf(ev.mirror);
    assert.equal(mirrored.menus.adultsDiffer, false, "the kids' menu said again is not the adults' own");
    assert.deepEqual(mirrored.menus.adults, []);
    assert.equal(mirror.body.written.kitchenLines, 2, "the folded adults' lines are not counted as written");
    assert.equal(mirror.body.written.adultsLinesFolded, 2, "and the answer says they were folded");
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_timeline_items where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from beo_set_menu_selections where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from birthday_package_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from entertainment_package_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_set_menu_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from users where id = $1", [manager]).catch(() => undefined);
  await q("delete from branches where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from tenants where id = $1", [tenant]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== CHECKS ? 1 : 0);
