// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub inbox, a stub till menu) and needs a
// database whose otoapp schema the app's migrator has built. It renders the
// review's own component and the till menu's marks, so it runs with
// TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-944 (Phase C of the BEO fill, the owner's go of 12 November): the fill
// matches the chat's dishes and drinks to the till's items and writes their
// codes:
//   - the conversation's read is handed the party's park's till food and
//     drink (code, name, category, station; no prices; nothing made for
//     another party's BEO), through SCRUM-905's door;
//   - the resolver accepts a till code only when the till's menu has it,
//     names the line by the till's own name, sends a drink made at the bar
//     to the bar plan, and keeps SCRUM-926's rule for a code several of the
//     party's set-menu options share;
//   - the review shows the match as it shows a set-menu match, with the
//     till's price, and opens an EXTRA at the chat's price, else the till's
//     weekday price; Fetch from chat lists it the same way;
//   - Approve and create writes the code as the line's own productCode (never
//     its note), in the kids', the adults' or the bar's list, checked against
//     the till's menu again; a dish the till does not sell stays a line for
//     staff to keep or leave out; no till product is ever made;
//   - the "No longer on the till" mark and the picker read the lines it
//     writes as lines picked by hand;
//   - a till that cannot be read leaves the fill as it was, and says so;
//   - (the lane's reviews) the till's price a coded adults' line opens with
//     is no price of its own: a coded mirror of the kids' dish stays a mirror;
//   - the guards hold: nothing written before Approve and create, typed text
//     never replaced, a claimed deposit sent as asked, a line the menu lacks
//     decided, an option nobody named waiting for staff, the chat's words
//     never in the approval or the activity row.
//
// Every model answer here is scripted: no model key is used.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-fill-till-menu.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-fill-till-menu.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-944";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "info";

// The log lines the fill writes, kept to check none holds the chat's words.
const logged: string[] = [];
const writeOut = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  logged.push(String(chunk));
  return (writeOut as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const { loadBeoCatalogue, BEO_TILL_MENU_RULES } = await import("../server/lib/beoCatalogueFill");
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, undecidedLines, undecidedOptions, menuLinePriceWords, tillMenuUnreadWords, NOTHING_HELD } = await import("../client/src/lib/beo-ai-review");
const { fetchCatalogueChangesOf } = await import("../client/src/lib/beo-fetch-from-chat");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { TillCodeMark, TillMenuContext } = await import("../client/src/components/beo/till-menu-picker");
const { tillMenuIndexOf, tillCodeState, isTemplateSetMenuLine, lineWithTillItem, TILL_CODE_DEAD } = await import("../shared/tillMenu");
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
type TillMenuItem = import("../shared/tillMenu").TillMenuItem;
type FillTillMenu = import("../server/lib/beoFillTillMenu").FillTillMenu;

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
const CHECKS = 9;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const coreBranch = randomUUID();
const manager = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID() };
const KEYS = ["till", "unread", "guards", "tillMirror", "tillOwn"] as const;
type Key = (typeof KEYS)[number];
const ev = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const conv = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const PIZZA = "item_944_pizza";
const RICE = "item_944_fried_rice";
const BOOKED = "2099-12-20";

const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" } },
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, productCode: "CF-43", optionProductCodes: {} },
  { id: "item_944_fries", type: "always_included", label: "French fries", productCode: "CF-11" },
  { id: "item_944_sticks", type: "always_included", label: "Veggie sticks", productCode: "CF-53" },
];

/** The till's menu at the park, as the platform answers it (a few of Central Floresta's own items). */
const item = (code: string, name: string, category: string, station: "kitchen" | "bar", baht: number, beoOnly = false): TillMenuItem => ({
  code, name, category, parentCategory: null, station, priceSatang: baht * 100, priceWeekendSatang: baht * 100, beoOnly,
});
const TILL: TillMenuItem[] = [
  item("CF-11", "French fries", "Sides", "kitchen", 120),
  item("CF-14", "Calamari", "Sharing", "kitchen", 260),
  item("CF-24", "Margherita", "Pizza", "kitchen", 320),
  item("CF-27", "Hawaiian", "Pizza", "kitchen", 340),
  item("CF-43", "Fried rice", "Asian food", "kitchen", 150),
  item("CF-53", "Vegetable sticks", "Sides", "kitchen", 90),
  item("CF-65-1", "Coke", "Soft drinks", "bar", 60),
  item("CF-63-1", "Fresh cold pressed orange juice", "Juice", "bar", 110),
  item("PARTY-ZZ944A1", "ZZ TEST 944 juice", "Made for a party", "bar", 50, true),
];
let tillState: "ok" | "down" = "ok";
const tillAsked: string[] = [];
const tillMenu = async (event: { id: string }): Promise<FillTillMenu> => {
  tillAsked.push(event.id);
  return tillState === "ok"
    ? { status: "ok", message: null, items: TILL }
    : { status: "not_reachable", message: "The till did not answer, so its menu cannot be offered.", items: [] };
};

const TEXTS = [
  "Hi, a party for ZZ Test Sami turning 8, Sunday 20 December 15:00-17:30, 14 kids and 10 adults. TILL-944",
  "The Floresta birthday package with the Margherita pizza. Calamari for the adults please, 3 portions, and 10 Cokes for the kids. One more Margherita pizza at 450. Some extra veggie sticks, 2 plates. And a dragon roll and the party juice. TILL-944",
  "Fried rice for the adults too. I already transferred the 3,000 deposit. TILL-944",
];
const ANSWER = {
  catalogue: {
    package: { templateId: cat.pkg, said: "The Floresta birthday package", line: 2 },
    setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Margherita", said: "the Margherita pizza", line: 2 }] },
    menuLines: [
      { productCode: "CF-14", itemName: "Calamari for the adults", menu: "adults", quantity: 3, line: 2 },
      { productCode: "CF-65-1", itemName: "10 Cokes for the kids", menu: "kids", quantity: 10, line: 2 },
      { productCode: "CF-24", itemName: "One more Margherita pizza", menu: "kids", quantity: 1, chatPrice: 450, line: 2 },
      { productCode: "CF-53", itemName: "extra veggie sticks", menu: "kids", quantity: 2, line: 2 },
      { productCode: "CF-999", itemName: "a dragon roll", menu: "kids", quantity: 1, line: 2 },
      { productCode: "PARTY-ZZ944A1", itemName: "the party juice", menu: "kids", quantity: 1, line: 2 },
      { productCode: "CF-43", itemName: "Fried rice for the adults", menu: "adults", quantity: 1, line: 3 },
    ],
    event: { numChildren: { value: 14, line: 1 }, numAdults: { value: 10, line: 1 }, startTime: { value: "15:00", line: 1 }, endTime: { value: "17:30", line: 1 } },
    deposit: { amount: 3000, paid: true, line: 3 },
    requests: [{ kind: "special_request", text: "a quiet corner", line: 2 }],
  },
};

const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    if (call.user.includes("TILL-944") && call.system.includes("THE CONVERSATION")) return JSON.stringify(ANSWER);
    return JSON.stringify({ summary: "ZZ plain" });
  },
};
const at = (i: number) => new Date(Date.UTC(2026, 10, 12, 7, i * 7)).toISOString();
const inbox = new Map<string, InboxRead>(
  KEYS.map((key) => [
    conv[key],
    {
      ok: true,
      confirmation: {
        conversationId: conv[key], eventId: ev[key], message: null, scanned: TEXTS.length,
        transcript: TEXTS.map((text, i) => ({ id: `${conv[key]}-${i}`, author: "customer" as const, at: at(i), text })), transcriptCut: false,
      },
    },
  ]),
);

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
  inboxConfirmation: async (_req, conversationId) => inbox.get(conversationId) ?? { ok: false, reason: "inbox_unreachable" },
  catalogue: async (event) => loadBeoCatalogue(db, { tenantId: event.tenantId, branchId: event.branchId }),
  tillMenu,
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
const fill = (eventId: string) => post(`/api/events/${eventId}/beo/ai-fill/inbox`, { existingData: { event: { title: "ZZ TEST" } } });
const approve = (eventId: string, body: unknown) => post(`/api/events/${eventId}/beo/ai-fill/approve`, body);
async function beoRows(eventId: string) {
  return {
    kitchen: (await q("select * from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null,
    bar: (await q("select * from beo_bar_plans where event_id = $1", [eventId]))[0] ?? null,
    billing: (await q("select * from beo_event_billing where event_id = $1", [eventId]))[0] ?? null,
    event: (await q("select special_requests from core_events where id = $1", [eventId]))[0]!,
    activity: await q("select summary_text, metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at", [`%${eventId}%`]),
  };
}
const viewOf = async (eventId: string) =>
  (await q<{ kitchen_plan: { lines: Array<Record<string, any>>; bar_lines: Array<Record<string, any>> } }>("select kitchen_plan from otoapp_v.event_packages where event_id = $1", [eventId]))[0]?.kitchen_plan ?? null;
const CHAT_WORDS = ["Calamari for the adults", "10 Cokes for the kids", "One more Margherita pizza", "extra veggie sticks", "a dragon roll", "the party juice", "Fried rice for the adults", "transferred", ...TEXTS];

let tillReview: BeoAiReview | null = null;
let tillFill: unknown = null;

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 944 ${run}`, `zz-944-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST Central Floresta 944', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, coreBranch]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 944', 'manager', true, false)", [
    manager, `zz-944-${manager.slice(0, 8)}@example.com`,
  ]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Birthday set menu 944', $3)", [cat.setMenu, tenant, JSON.stringify(setMenuItems)]);
  await q(
    `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours,
       price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, set_menu_template_id, branch_id, sort_order)
     values ($1, $2, 'Birthday package 944', 1690000, 10, 4, -1, 3, 1690000, 2090000, 130000, 150000, $3, $4, 1)`,
    [cat.pkg, tenant, cat.setMenu, park],
  );
  for (const key of KEYS) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, status, inbox_conversation_id, special_requests)
       values ($1, $2, $3, 'birthday', $4, $5, '15:00', 'tentative', $6, $7)`,
      [ev[key], tenant, park, `ZZ TEST 944 ${key}`, BOOKED, conv[key], key === "guards" ? "ZZ typed by staff: a seat for grandma" : null],
    );
  }

  await check("theReadIsHandedTheTillsFoodAndDrink", async () => {
    const before = modelCalls.length;
    const res = await fill(ev.till);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    tillReview = res.body.review;
    tillFill = res.body.fill;
    const call = modelCalls.slice(before).find((c) => c.system.includes("THE CONVERSATION"))!;
    assert.ok(call, "the conversation was read");
    // The till's items as a table: code, name, category, station; no price, no item made for another party.
    assert.ok(call.system.includes('"tillMenu":{"columns":["code","name","category","station"]'), "the till's menu rides the catalogue");
    assert.ok(call.system.includes('["CF-14","Calamari","Sharing","kitchen"]') && call.system.includes('["CF-65-1","Coke","Soft drinks","bar"]'));
    assert.ok(!call.system.includes("PARTY-ZZ944A1"), "nothing made for another party's BEO");
    assert.ok(!call.system.includes("26000") && !call.system.includes('"priceSatang"'), "no till price is handed to the model");
    assert.ok(call.system.includes(BEO_TILL_MENU_RULES), "with how to match it");
    assert.ok(tillAsked.includes(ev.till), "the till's menu was asked for the party's park");
    assert.deepEqual(tillReview!.tillMenu, { status: "ok", message: null });
    assert.equal(tillReview!.catalogue.till?.some((t) => t.code === "PARTY-ZZ944A1"), false);
  });

  await check("aCodeIsTheTillsOnlyWhenTheTillHasIt", async () => {
    const lines = tillReview!.proposal.menuLines.map((l) => [l.menu, l.productCode, l.matchedName, l.notInMenu, l.quantity]);
    assert.deepEqual(lines, [
      ["adults", "CF-14", "Calamari", false, 3],
      ["bar", "CF-65-1", "Coke", false, 10],
      ["kids", "CF-24", "Margherita", false, 1],
      ["kids", "CF-53", "Vegetable sticks", false, 2],
      ["kids", null, null, true, 1],
      ["kids", null, null, true, 1],
      ["adults", "CF-43", null, false, 1],
    ], "the till's own names; a Coke to the bar; a made-up code and another party's item are lines the menu lacks; SCRUM-926 kept for the shared fried rice");
    // The activity row counts the till's matches, never the chat's words.
    const rows = await beoRows(ev.till);
    const meta = JSON.parse(rows.activity.at(-1)!.metadata_json);
    assert.equal(meta.catalogue.tillLines, 2, "Calamari and Coke: on the till, on no set menu");
    for (const w of CHAT_WORDS) {
      assert.ok(!rows.activity.some((r) => r.metadata_json.includes(w) || r.summary_text.includes(w)), `no "${w}" in the activity row`);
      assert.ok(!logged.some((l) => l.includes(w)), `no "${w}" in the logs`);
    }
    // Nothing is written by the fill.
    assert.equal(rows.kitchen, null);
    assert.equal(rows.bar, null);
  });

  await check("theReviewShowsTheTillsItemCodeAndPrice", async () => {
    const review = tillReview!;
    const state = initialReviewState(review, { fill: tillFill });
    const by = (code: string | null, i = 0) => state.menuLines.filter((l) => l.productCode === code)[i]!;
    assert.deepEqual([by("CF-14").price, by("CF-14").priceFrom], [260, "till"], "an EXTRA at the till's weekday price");
    assert.deepEqual([by("CF-24").price, by("CF-24").priceFrom], [450, "chat"], "the chat's price first");
    assert.deepEqual([by("CF-65-1").price, by("CF-65-1").priceFrom], [60, "till"]);
    assert.equal(menuLinePriceWords(by("CF-14")), "THB each, written on the line as an EXTRA (3 × ฿260 = ฿780) — the till's price.");
    assert.equal(by(null).price, null, "a dish the till does not sell has no price of the till's");
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
    assert.ok(html.includes("Calamari for the adults → Calamari (CF-14)"), "the chat's words, then the till's item and its code");
    assert.ok(html.includes("Till ฿260") && html.includes("Till ฿60"), "and the till's price");
    assert.ok(html.includes("— the till&#x27;s price."), "the price as it will be written");
    assert.ok(html.includes("The chat says “Calamari for the adults”"), "with the reason line");
    assert.equal(undecidedLines(state), 2, "the dragon roll and the party juice wait for a decision");
    assert.equal(undecidedOptions(state), 1, "the fried rice's option waits for staff");
    assert.equal(tillMenuUnreadWords(review), null);
    // Fetch from chat lists the same match.
    const listed = fetchCatalogueChangesOf(review, { package: null, packageItems: [], setMenuTemplateId: cat.setMenu, menuLines: [], entertainment: [] }, { specialRequests: "" });
    assert.ok(listed.some((c) => c.section === "food" && c.now === "Calamari for the adults → Calamari (CF-14) × 3 · Till ฿260"), JSON.stringify(listed.map((c) => c.now)));
    assert.ok(listed.some((c) => c.section === "food" && c.label === "Bar" && c.now.includes("Coke (CF-65-1)")));
  });

  await check("approvalWritesTheCodeAsTheLinesOwnProductCode", async () => {
    const review = tillReview!;
    const state = initialReviewState(review, { fill: tillFill });
    const decided = {
      ...state,
      menuLines: state.menuLines
        .map((l) => (l.notInMenu ? { ...l, decision: (l.itemName === "a dragon roll" ? "keep" : "drop") as "keep" | "drop" } : l))
        .map((l) => (l.productCode === "CF-43" ? { ...l, matchedName: "Fried rice (Chicken)", changed: true } : l)),
    };
    assert.equal(undecidedLines(decided), 0);
    assert.equal(undecidedOptions(decided), 0);
    const body = approveBodyOf(review, decided, { conversationId: review.conversationId ?? null, messageId: null });
    const json = JSON.stringify(body);
    assert.ok(!json.includes("quote") && TEXTS.every((t) => !json.includes(t)), "the chat's words never ride the approval");
    const res = await approve(ev.till, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = await beoRows(ev.till);
    const line = (list: any[], code: string | null, name?: string) => list.find((l) => (l.productCode ?? null) === code && (name === undefined || l.itemName === name));
    const kids = rows.kitchen.menus.kids as any[];
    const adults = rows.kitchen.menus.adults as any[];
    assert.deepEqual(
      [line(adults, "CF-14")?.itemName, line(adults, "CF-14")?.quantity, line(adults, "CF-14")?.price, line(adults, "CF-14")?.notes],
      ["Calamari", 3, 260, ""],
      "the adults' Calamari: the till's name, code and price, nothing in the note",
    );
    assert.deepEqual([line(kids, "CF-24", "Margherita")?.price, line(kids, "CF-24", "Margherita")?.source], [450, "additional"], "the extra pizza at the chat's price, an EXTRA");
    assert.deepEqual([line(kids, "CF-53")?.itemName, line(kids, "CF-53")?.price], ["Vegetable sticks", 90]);
    // SCRUM-958 (the owner's rule of 12 November): "Fried rice for the adults too" is the set menu's Fried
    // rice on the adults' own menu, a SET line by the option chosen (not charged), no longer an EXTRA at CF-43.
    const rice = adults.find((l) => l.groupId === RICE);
    assert.deepEqual([rice?.itemName, rice?.source, rice?.price, line(adults, "CF-43")], ["Chicken", "set_menu", 0, undefined], "SCRUM-926: the option chosen");
    const dragon = kids.find((l) => l.itemName === "a dragon roll");
    assert.deepEqual([dragon?.productCode, dragon?.notes, dragon?.price], [undefined, "Not in the menu", 0], "a dish the till does not sell: by name, as today");
    assert.equal(kids.some((l) => l.itemName === "the party juice"), false, "left out");
    // The Coke is the bar plan's, with its code and the till's price.
    const coke = (rows.bar.items as any[]).find((l) => l.productCode === "CF-65-1");
    assert.deepEqual([coke?.itemName, coke?.quantity, coke?.price, coke?.notes], ["Coke", 10, 60, ""]);
    // The till's plan reads the codes: the kitchen lines and the bar line, at the prices written.
    const view = await viewOf(ev.till);
    const viewLine = (code: string) => view!.lines.find((l) => l.product_code === code && l.source === "extra");
    assert.deepEqual([viewLine("CF-14")?.qty, viewLine("CF-14")?.unit_price_satang], [3, 26000]);
    assert.deepEqual([viewLine("CF-24")?.unit_price_satang], [45000]);
    assert.deepEqual(view!.bar_lines.map((l) => [l.product_code, l.qty, l.unit_price_satang]), [["CF-65-1", 10, 6000]]);
    // No till product was made, and the activity row names codes, never the chat's words.
    const meta = rows.activity.map((r) => JSON.parse(r.metadata_json)).find((m) => m.step === "approved");
    assert.ok(meta.matches.some((m: any) => m.kind === "menu" && m.code === "CF-14" && m.name === "Calamari"));
    assert.ok(meta.matches.some((m: any) => m.kind === "bar" && m.code === "CF-65-1"));
    for (const w of CHAT_WORDS) assert.ok(!rows.activity.some((r) => r.metadata_json.includes(w)), `no "${w}" in the activity row`);
  });

  await check("theTillsMarksReadTheLinesTheFillWrites", async () => {
    const rows = await beoRows(ev.till);
    const written = (rows.kitchen.menus.adults as any[]).find((l) => l.productCode === "CF-14");
    const coke = (rows.bar.items as any[]).find((l) => l.productCode === "CF-65-1");
    assert.equal(isTemplateSetMenuLine(written), false, "the picker is offered on it");
    // The picker writes the same name and code on a line it picks: the fill's line is that line.
    const picked = lineWithTillItem({ ...written, itemName: "anything", productCode: undefined }, TILL[1]!);
    assert.deepEqual([picked.itemName, picked.productCode, picked.price], [written.itemName, written.productCode, written.price]);
    const live = tillMenuIndexOf([{ parkId: park, parkName: "ZZ", status: "ok", message: null, items: TILL, readAt: at(9) }]);
    const gone = tillMenuIndexOf([{ parkId: park, parkName: "ZZ", status: "ok", message: null, items: TILL.filter((t) => t.code !== "CF-14"), readAt: at(9) }]);
    assert.equal(tillCodeState(live, written.productCode), "live");
    assert.equal(tillCodeState(gone, written.productCode), "dead");
    assert.equal(tillCodeState(live, coke.productCode), "live");
    const mark = (index: ReturnType<typeof tillMenuIndexOf>, code: string) =>
      renderToStaticMarkup(
        React.createElement(TillMenuContext.Provider, { value: { index, parks: null, loading: false, message: null, editable: true } }, React.createElement(TillCodeMark, { code, testId: "zz-mark" })),
      );
    assert.equal(mark(live, written.productCode).includes(TILL_CODE_DEAD), false, "on the till: no mark");
    assert.equal(mark(gone, written.productCode).includes(TILL_CODE_DEAD), true, "gone from the till: No longer on the till");
    const unknown = tillMenuIndexOf([{ parkId: park, parkName: "ZZ", status: "not_reachable", message: "down", items: [], readAt: null }]);
    assert.equal(mark(unknown, written.productCode).includes(TILL_CODE_DEAD), false, "a till not read marks nothing");
  });

  await check("aTillThatCannotBeReadLeavesTheFillAsItWas", async () => {
    tillState = "down";
    try {
      const before = modelCalls.length;
      const res = await fill(ev.unread);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const review: BeoAiReview = res.body.review;
      const call = modelCalls.slice(before).find((c) => c.system.includes("THE CONVERSATION"))!;
      assert.ok(!call.system.includes('"tillMenu"') && !call.system.includes(BEO_TILL_MENU_RULES), "the read is as it was before Phase C");
      assert.equal(review.tillMenu?.status, "not_reachable");
      assert.ok(tillMenuUnreadWords(review)!.startsWith("The till's menu was not available (The till did not answer, so its menu cannot be offered)"));
      const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state: initialReviewState(review, {}), onChange: () => undefined }));
      assert.ok(!html.includes("Till ฿"), "no till price shown");
      const lines = review.proposal.menuLines.map((l) => [l.productCode, l.notInMenu]);
      assert.deepEqual(lines.slice(0, 4), [[null, true], [null, true], ["CF-24", false], ["CF-53", false]], "only what the set menus code is matched");
      // Approve: a set menu's code is written; a till code cannot be checked, so it is not written.
      const ok = await approve(ev.unread, {
        conversationId: null, messageId: null, package: null, setMenu: null, entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
        menuLines: [{ menu: "kids", itemName: "extra veggie sticks", quantity: 2, productCode: "CF-53", notes: null }],
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const refused = await approve(ev.unread, {
        conversationId: null, messageId: null, package: null, setMenu: null, entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
        menuLines: [{ menu: "adults", itemName: "Calamari", quantity: 3, productCode: "CF-14", notes: null }],
      });
      assert.equal(refused.status, 400);
      assert.match(refused.body.message, /could not be read just now/);
      const kids = ((await beoRows(ev.unread)).kitchen.menus.kids as any[]).map((l) => [l.itemName, l.productCode]);
      assert.deepEqual(kids, [["Veggie sticks", "CF-53"]], "the set menu's name with the till not read; nothing of the refused approval");
    } finally {
      tillState = "ok";
    }
  });

  await check("aCodeTheTillLacksIsRefused", async () => {
    const body = (productCode: string) => ({
      conversationId: null, messageId: null, package: null, setMenu: null, entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
      menuLines: [{ menu: "kids", itemName: "ZZ made up", quantity: 1, productCode, notes: null }],
    });
    const refused = await approve(ev.guards, body("CF-999"));
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /the till's menu does not have/);
    const party = await approve(ev.guards, body("PARTY-ZZ944A1"));
    assert.equal(party.status, 400, "another party's BEO item is no dish of this party's");
    assert.equal((await beoRows(ev.guards)).kitchen, null, "nothing written");
  });

  await check("theGuardsHoldWithTheTillsMenu", async () => {
    const res = await fill(ev.guards);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    let rows = await beoRows(ev.guards);
    assert.equal(rows.kitchen, null, "nothing written before Approve and create");
    assert.equal(rows.bar, null);
    assert.equal(rows.billing, null);
    const held = { ...NOTHING_HELD, specialRequests: "ZZ typed by staff: a seat for grandma" };
    const state = initialReviewState(review, { fill: res.body.fill, held, saved: held });
    assert.equal(state.details.specialRequests.value, "ZZ typed by staff: a seat for grandma", "typed text is never replaced");
    assert.equal(state.deposit?.value.paid, false, "a deposit the family only claims opens as asked");
    assert.equal(undecidedLines(state), 2, "a line the menu lacks must be decided");
    assert.equal(undecidedOptions(state), 1, "an option nobody named waits for staff");
    const decided = { ...state, menuLines: state.menuLines.filter((l) => !l.notInMenu && l.productCode !== "CF-43") };
    const body = approveBodyOf(review, decided, { conversationId: review.conversationId ?? null, messageId: null });
    assert.deepEqual(body.deposit, { amount: 3000, paid: false, date: null }, "sent as asked");
    assert.equal(body.details?.specialRequests, undefined, "the typed text is the form's");
    const ok = await approve(ev.guards, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    rows = await beoRows(ev.guards);
    assert.equal(rows.billing.deposit_paid, false, "no money received");
    assert.equal(rows.event.special_requests, "ZZ typed by staff: a seat for grandma", "the typed text stands; the chat's line was offered beside it, not over it");
    for (const r of rows.activity) for (const w of CHAT_WORDS) assert.ok(!r.metadata_json.includes(w) && !r.summary_text.includes(w), `no "${w}" in the activity row`);
  });

  // The lane's reviews: once Phase C codes a dish, its adults' copy opens at the till's price; that
  // is no price of the adults' own, so a mirror of the kids' dish still folds (SCRUM-829).
  await check("aCodedMirrorOfTheKidsDishStaysAMirror", async () => {
    tillState = "ok";
    const lines = (adultsPrice: number) => [
      { menu: "kids" as const, itemName: "Calamari", quantity: 14, productCode: "CF-14", notes: null, price: 260 },
      { menu: "adults" as const, itemName: "calamari", quantity: 10, productCode: "CF-14", notes: "adults eat the same as the kids", price: adultsPrice },
    ];
    const body = (adultsPrice: number) => ({
      conversationId: null, messageId: null, package: null, setMenu: null, menuLines: lines(adultsPrice), entertainment: [], otherLines: [],
      event: { numAdults: 10 }, cake: null, deposit: null, sources: [],
    });
    const mirror = await approve(ev.tillMirror, body(260));
    assert.equal(mirror.status, 200, JSON.stringify(mirror.body));
    let rows = await beoRows(ev.tillMirror);
    assert.equal(rows.kitchen.menus.adultsDiffer, false, "the till's price is no price of the adults' own");
    assert.deepEqual(rows.kitchen.menus.adults, []);
    assert.equal(mirror.body.written.adultsLinesFolded, 1);
    const view = await viewOf(ev.tillMirror);
    assert.deepEqual((view?.lines ?? []).filter((l) => l.source === "extra").map((l) => [l.name, l.qty]), [["Calamari", 14]], "the kids' 14 charged once, nothing for a mirror");
    // A price of the adults' own (the chat's, or one staff entered): their own order.
    const own = await approve(ev.tillOwn, body(300));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    rows = await beoRows(ev.tillOwn);
    assert.equal(rows.kitchen.menus.adultsDiffer, true);
    assert.deepEqual((rows.kitchen.menus.adults as any[]).map((l) => [l.itemName, l.quantity, l.price, l.productCode]), [["Calamari", 10, 300, "CF-14"]]);
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_timeline_items where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from beo_set_menu_selections where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from birthday_package_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_set_menu_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from users where id = $1", [manager]).catch(() => undefined);
  await q("delete from branches where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from tenants where id = $1", [tenant]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

process.stdout.write = writeOut;
console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== CHECKS ? 1 : 0);
