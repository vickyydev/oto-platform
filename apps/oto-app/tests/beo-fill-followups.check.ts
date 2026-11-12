// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub inbox, a stub till menu) and needs a
// database whose otoapp schema the app's migrator has built. It renders the
// review's own component, so it runs with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-958 (the follow-ups of the BEO fill's staging proof of 12 November,
// docs/qa/proof-2026-11-12/SCRUM-944), with the proof's own threads:
//   1. thread A, "And chicken fried rice for the adults.": words said for the
//      adults never choose for the kids. The kids' Fried rice stays "Not
//      chosen yet"; the adults get their own menu ("Different for adults"
//      on, the kids' set menu copied) and on it the set menu's Fried rice:
//      Chicken as a SET line, not charged. Chosen for the kids and otherwise
//      for the adults, both stand; words that name nobody stay the set
//      menu's choice.
//   2. thread B, "fried rice for the adults please": the same reading, its
//      option for staff to choose before Approve (SCRUM-926's hold); a
//      charged EXTRA only when the family asks for more, names a price or a
//      count of its own — thread D's "3 more Margherita pizzas for the
//      adults" is written exactly as SCRUM-946 proved it.
//
// Every model answer here is scripted (the proof's own words): no model key is used.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-fill-followups.check.ts
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
  console.error("beo-fill-followups.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-958";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "info";

const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const { loadBeoCatalogue, resolveCatalogueAnswer, saidForTheAdults } = await import("../server/lib/beoCatalogueFill");
type TranscriptRef = import("../server/lib/beoCatalogueFill").TranscriptRef;
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, undecidedOptions, approvalResultWords } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { adultsSetMenuLineWords, setMenuOptionOf } = await import("../shared/beoAiFill");
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
type BeoAiCatalogueView = import("../shared/beoAiFill").BeoAiCatalogueView;
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
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
const CHECKS = 4;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const coreBranch = randomUUID();
const manager = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID() };
const KEYS = ["A", "B", "D", "G", "Gown", "I", "both"] as const;
type Key = (typeof KEYS)[number];
const ev = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const conv = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const PIZZA = "item_958_pizza";
const HOT = "item_958_hot_dish";
const RICE = "item_958_fried_rice";
const FRIES = "item_958_fries";
const STICKS = "item_958_sticks";
const BOOKED = "2099-12-05";

// The park's set menu as staging holds it (Birthday set menu, Central Floresta).
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian", "Pepperoni"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27", Pepperoni: "CF-31" } },
  { id: HOT, type: "choice_group", label: "Hot dish", options: ["Chicken schnitzel", "Fish fingers"], allowMultiple: false, optionProductCodes: {} },
  { id: FRIES, type: "always_included", label: "French fries", productCode: "CF-11" },
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, productCode: "CF-43", optionProductCodes: {} },
  { id: STICKS, type: "always_included", label: "Veggie sticks", productCode: "CF-53" },
];
/** The till's menu at the park (Central Floresta's own items and prices). */
const item = (code: string, name: string, category: string, station: "kitchen" | "bar", baht: number): TillMenuItem => ({
  code, name, category, parentCategory: null, station, priceSatang: baht * 100, priceWeekendSatang: baht * 100, beoOnly: false,
});
const TILL: TillMenuItem[] = [
  item("CF-11", "French fries", "Sides", "kitchen", 175),
  item("CF-15", "Caesar salad", "Salads", "kitchen", 370),
  item("CF-24", "Margherita", "Pizza", "kitchen", 400),
  item("CF-27", "Hawaiian", "Pizza", "kitchen", 515),
  item("CF-31", "Pepperoni", "Pizza", "kitchen", 420),
  item("CF-43", "Fried rice", "Asian Food", "kitchen", 240),
  item("CF-53", "Vegetable sticks", "Sides", "kitchen", 90),
];
const tillMenu = async (): Promise<FillTillMenu> => ({ status: "ok", message: null, items: TILL });

// The proof's own threads (proof.mjs, CONVS and LINES): the family's first line, then its menu line.
const THREADS: Record<"A" | "B" | "D" | "G" | "I", string[]> = {
  A: [
    "Hi! We'd like to book a birthday party for our daughter ZZ Test Lina, she turns 6. Saturday 5 December, from 14:00 to 16:30, 12 kids and 8 adults. (ZZ TEST)",
    "We'd like the Floresta birthday package. Hawaiian pizza for the kids, no pineapple on half. And chicken fried rice for the adults. (ZZ TEST)",
  ],
  B: [
    "Hello, a birthday party for ZZ Test Mika turning 7 on Sunday 13 December, 10:00 to 12:00, 10 kids and 6 adults. (ZZ TEST)",
    "The Floresta birthday package please, and fried rice for the adults please. I already transferred the 3,000 deposit. (ZZ TEST)",
  ],
  D: [
    "Hi, a party for ZZ Test Sami turning 8, Sunday 20 December 15:00-17:30, 14 kids and 10 adults. (ZZ TEST)",
    "The Floresta birthday package. For the kids' set menu the Margherita pizza please. On top of that, 2 more Margherita pizzas for the kids on the side at 450 each, and 3 more Margherita pizzas for the adults. (ZZ TEST)",
  ],
  G: [
    "Hi, a party for ZZ Test Remy turning 6, Saturday 12 December 11:00-13:00, 12 kids and 8 adults. (ZZ TEST)",
    "The Floresta birthday package with the Margherita pizza for the kids. The adults will eat the same as the kids, the Margherita pizza for them too. (ZZ TEST)",
  ],
  I: [
    "Hi, a party for ZZ Test Noa turning 5, Sunday 27 December 14:00-16:00, 10 kids and 5 adults. (ZZ TEST)",
    "The Floresta birthday package, Hawaiian pizza for the kids. For the adults a Pepperoni pizza at 300 please, and 2 Margherita pizzas for 900. And 3 extra portions of French fries for the kids. (ZZ TEST)",
  ],
};
const counts = (kids: number, adults: number) => ({ numChildren: { value: kids, line: 1 }, numAdults: { value: adults, line: 1 } });
// The model's answers, as the proof's runs read them (receipt.json, fills.*.aiFill.rawProposal), before the app resolved them.
const ANSWERS: Record<string, unknown> = {
  A: {
    package: { templateId: cat.pkg, said: "the Floresta birthday package", line: 2 },
    setMenu: {
      templateId: cat.setMenu, line: 2,
      choices: [
        { itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza for the kids", notes: "no pineapple on half", line: 2 },
        { itemId: RICE, option: "Chicken", said: "chicken fried rice for the adults", line: 2 },
      ],
    },
    event: counts(12, 8),
  },
  B: {
    package: { templateId: cat.pkg, said: "The Floresta birthday package", line: 2 },
    menuLines: [{ productCode: "CF-43", itemName: "fried rice for the adults", menu: "adults", quantity: 1, line: 2 }],
    event: counts(10, 6),
  },
  D: {
    package: { templateId: cat.pkg, said: "The Floresta birthday package", line: 2 },
    setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Margherita", said: "the Margherita pizza please", line: 2 }] },
    menuLines: [
      { productCode: "CF-24", itemName: "2 more Margherita pizzas for the kids on the side", menu: "kids", quantity: 2, chatPrice: 450, line: 2 },
      { productCode: "CF-24", itemName: "3 more Margherita pizzas for the adults", menu: "adults", quantity: 3, line: 2 },
    ],
    event: counts(14, 10),
  },
  G: {
    package: { templateId: cat.pkg, said: "The Floresta birthday package", line: 2 },
    setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Margherita", said: "the Margherita pizza for the kids", line: 2 }] },
    menuLines: [{ productCode: "CF-24", itemName: "the Margherita pizza for them too", menu: "adults", quantity: 8, line: 2 }],
    event: counts(12, 8),
  },
  I: {
    package: { templateId: cat.pkg, said: "The Floresta birthday package", line: 2 },
    setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza for the kids", line: 2 }] },
    menuLines: [
      { productCode: "CF-31", itemName: "Pepperoni pizza", menu: "adults", quantity: 1, chatPrice: 300, line: 2 },
      { productCode: "CF-24", itemName: "Margherita pizzas", menu: "adults", quantity: 2, chatPrice: 900, line: 2 },
      { productCode: "CF-11", itemName: "3 extra portions of French fries", menu: "kids", quantity: 3, line: 2 },
    ],
    event: counts(10, 5),
  },
};

const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    if (call.system.includes("THE CONVERSATION")) {
      for (const key of Object.keys(ANSWERS)) if (call.user.includes(THREADS[key as keyof typeof THREADS][1]!)) return JSON.stringify({ catalogue: ANSWERS[key] });
    }
    return JSON.stringify({ summary: "ZZ plain" });
  },
};
const at = (i: number) => new Date(Date.UTC(2026, 10, 12, 15, 30 + i)).toISOString();
const threadOf = (key: Key): keyof typeof THREADS => (key === "Gown" ? "G" : key === "both" ? "A" : key) as keyof typeof THREADS;
const inboxOf = (key: Key): InboxRead => {
  const texts = THREADS[threadOf(key)];
  return {
    ok: true,
    confirmation: {
      conversationId: conv[key], eventId: ev[key], message: null, scanned: texts.length,
      transcript: texts.map((text, i) => ({ id: `${conv[key]}-${i}`, author: "customer" as const, at: at(i), text })), transcriptCut: false,
    },
  };
};

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
const kitchenOf = async (eventId: string) => (await q("select * from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null;
const viewLinesOf = async (eventId: string) =>
  ((await q<{ kitchen_plan: { lines: Array<Record<string, any>> } }>("select kitchen_plan from otoapp_v.event_packages where event_id = $1", [eventId]))[0]?.kitchen_plan?.lines ?? []);
const selectionOf = async (eventId: string) => (await q("select selections from beo_set_menu_selections where event_id = $1", [eventId]))[0]?.selections ?? null;
const html = (review: BeoAiReview, state: ReturnType<typeof initialReviewState>) =>
  renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
const ids = { conversationId: null, messageId: null };
/** Words as the review renders them (React escapes quotes). */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
/** A resolved read of the proof's words for the pure checks, on the park's catalogue with the till's menu. */
let catalogue: BeoAiCatalogueView;
const refsOf = (texts: string[]): TranscriptRef[] => texts.map((text, i) => ({ line: i + 1, id: `r${i}`, source: "family", at: at(i), ruling: false, text }));

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 958 ${run}`, `zz-958-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST Central Floresta 958', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, coreBranch]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 958', 'manager', true, false)", [
    manager, `zz-958-${manager.slice(0, 8)}@example.com`,
  ]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Birthday set menu 958', $3)", [cat.setMenu, tenant, JSON.stringify(setMenuItems)]);
  await q(
    `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours,
       price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, set_menu_template_id, branch_id, sort_order)
     values ($1, $2, 'Birthday package 958', 1690000, 10, 4, -1, 3, 1690000, 2090000, 130000, 150000, $3, $4, 1)`,
    [cat.pkg, tenant, cat.setMenu, park],
  );
  for (const key of KEYS) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, status, inbox_conversation_id, num_children, num_adults)
       values ($1, $2, $3, 'birthday', $4, $5, '14:00', '16:30', 'tentative', $6, 12, 8)`,
      [ev[key], tenant, park, `ZZ TEST 958 ${key}`, BOOKED, conv[key]],
    );
  }
  catalogue = { ...(await loadBeoCatalogue(db, { tenantId: tenant, branchId: park })), till: TILL.map((t) => ({ code: t.code, name: t.name, category: t.category, station: t.station, priceSatang: t.priceSatang })) };

  // --- 1. Words said for the adults never choose for the kids (thread A) ------------------------
  await check("threadA_aChoiceSaidForTheAdultsIsTheAdultsSetLine", async () => {
    const res = await fill(ev.A);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    const p = review.proposal;
    assert.deepEqual(p.setMenu?.choices.map((c) => [c.itemId, c.option]), [[PIZZA, "Hawaiian"]], "the kids' pizza only: the adults' fried rice is no kids' choice");
    assert.deepEqual(
      p.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.productCode, l.matchedName, l.chatPrice, l.quantity]),
      [["adults", RICE, "CF-43", "Fried rice (Chicken)", null, 1]],
      "the adults' own set-menu dish, with the option the chat names",
    );
    const state = initialReviewState(review, { fill: res.body.fill });
    assert.equal(state.choices[RICE], undefined, "the kids' Fried rice: Not chosen yet");
    assert.deepEqual([state.menuLines[0]?.price, state.menuLines[0]?.priceFrom], [null, null], "no price: a SET line, never the till's 240");
    assert.equal(undecidedOptions(state), 0, "the chat names the option");
    const page = html(review, state);
    assert.ok(page.includes(`data-testid="select-ai-review-choice-${RICE}"`), "the kids' Fried rice row is there");
    const riceRow = page.slice(page.indexOf(`data-testid="ai-review-choice-${RICE}"`));
    assert.ok(riceRow.slice(0, riceRow.indexOf("</select>")).includes('<option value="" selected="">Not chosen yet</option>'), "and says Not chosen yet");
    assert.ok(page.includes(esc(adultsSetMenuLineWords("Fried rice"))), "the adults' line says what it is");
    assert.ok(page.includes("The chat says “chicken fried rice for the adults”"), "with its reason from the chat");
    assert.ok(!page.includes('data-testid="input-ai-review-menu-price"'), "no price box on a SET line");
    assert.ok(!page.includes("Till ฿240"), "no till price beside it");
    const body = approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null });
    assert.deepEqual(body.setMenu?.choices.map((c) => [c.itemId, c.options]), [[PIZZA, ["Hawaiian"]]]);
    assert.deepEqual(
      body.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.option ?? null, l.price ?? null]),
      [["adults", RICE, "Fried rice (Chicken)", null]],
    );
    const ok = await approve(ev.A, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const plan = await kitchenOf(ev.A);
    assert.equal(plan.menus.adultsDiffer, true, "Different for adults on, as staff switching it on");
    const line = (l: any) => [l.itemName, l.source ?? null, l.groupId ?? null, l.notes, l.price, l.included];
    assert.deepEqual((plan.menus.kids as any[]).filter((l) => l.groupId === RICE), [], "nothing chosen for the kids' Fried rice");
    assert.deepEqual(
      (plan.menus.adults as any[]).map(line),
      [
        ["Hawaiian", "set_menu", PIZZA, "(Pizza) · no pineapple on half", 0, true],
        ["French fries", "set_menu", FRIES, "", 0, true],
        ["Veggie sticks", "set_menu", STICKS, "", 0, true],
        ["Chicken", "set_menu", RICE, "(Fried rice)", 0, true],
      ],
      "the kids' set menu copied, then the adults' Fried rice: Chicken as a SET line",
    );
    assert.equal((plan.menus.adults as any[]).at(-1).id, `set_${RICE}_Chicken_adults`, "the adults' copy's id");
    assert.deepEqual((await selectionOf(ev.A) as any[]).map((s) => s.groupId), [PIZZA], "the recorded choices: the kids' pizza alone");
    // The till: the adults' Chicken is a SET line, never charged.
    const lines = await viewLinesOf(ev.A);
    assert.deepEqual(lines.filter((l) => l.source === "extra"), [], `no EXTRA: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.name === "Chicken" && l.source === "set_menu" && l.audience === "adults"), JSON.stringify(lines));
    assert.equal(ok.body.written.adultsSetLines, 1);
    assert.equal(approvalResultWords(ok.body).includes("only repeat"), false, "nothing folded");
  });

  await check("threadA_wordsNamingNobodyOrBothStayTheSetMenusChoice", async () => {
    const read = (texts: string[], choices: unknown[]) =>
      resolveCatalogueAnswer({ setMenu: { templateId: cat.setMenu, line: 1, choices }, event: counts(12, 8) }, catalogue, refsOf(texts));
    // Chosen for the kids and otherwise for the adults: both stand.
    const both = read(["Veggie fried rice for the kids and chicken fried rice for the adults please."], [
      { itemId: RICE, option: "Veggie", said: "Veggie fried rice", line: 1 },
      { itemId: RICE, option: "Chicken", said: "chicken fried rice", line: 1 },
    ]);
    assert.deepEqual(both.setMenu?.choices.map((c) => c.option), ["Veggie"], "the kids' Veggie");
    assert.deepEqual(both.menuLines.map((l) => [l.menu, l.setMenuItemId, l.matchedName]), [["adults", RICE, "Fried rice (Chicken)"]], "the adults' Chicken");
    // Words that name nobody: the set menu's choice, as today.
    const nobody = read(["The Floresta package with chicken fried rice please."], [{ itemId: RICE, option: "Chicken", said: "chicken fried rice", line: 1 }]);
    assert.deepEqual([nobody.setMenu?.choices.map((c) => c.option), nobody.menuLines.length], [["Chicken"], 0]);
    // For the kids and the adults alike: the kids' choice, which the adults eat.
    const all = read(["Chicken fried rice for the kids and the adults."], [{ itemId: RICE, option: "Chicken", said: "Chicken fried rice for the kids and the adults", line: 1 }]);
    assert.deepEqual([all.setMenu?.choices.map((c) => c.option), all.menuLines.length], [["Chicken"], 0]);
    // The same option for the kids and again for the adults: the adults' line is the kids' menu repeated.
    const same = read(["Chicken fried rice for the kids. Chicken fried rice for the adults too."], [
      { itemId: RICE, option: "Chicken", said: "Chicken fried rice for the kids", line: 1 },
      { itemId: RICE, option: "Chicken", said: "Chicken fried rice for the adults too", line: 1 },
    ]);
    assert.deepEqual([same.setMenu?.choices.map((c) => c.option), same.menuLines.length], [["Chicken"], 0]);
    // A dish the model put on the kids' list whose words are said for the adults: the adults'.
    const kidsLine = resolveCatalogueAnswer(
      { setMenu: { templateId: cat.setMenu, line: 1, choices: [] }, menuLines: [{ productCode: "CF-43", itemName: "chicken fried rice", menu: "kids", line: 1 }], event: counts(12, 8) },
      catalogue,
      refsOf(["Hawaiian pizza for the kids, and chicken fried rice for the adults."]),
    );
    assert.deepEqual(kidsLine.menuLines.map((l) => [l.menu, l.matchedName]), [["adults", "Fried rice (Chicken)"]]);
    // Thai and Russian, as the fill's other adult tests read them.
    assert.equal(saidForTheAdults("ข้าวผัดไก่สำหรับผู้ใหญ่", null), true);
    assert.equal(saidForTheAdults("ข้าวผัดไก่", "พิซซ่าฮาวายเอี้ยนสำหรับเด็ก, ข้าวผัดไก่สำหรับผู้ใหญ่"), true);
    assert.equal(saidForTheAdults("Жареный рис с курицей для взрослых", null), true);
    assert.equal(saidForTheAdults("жареный рис с курицей", "Детям пиццу, а жареный рис с курицей для взрослых."), true);
    assert.equal(saidForTheAdults("пицца для детей", null), false);
    assert.equal(saidForTheAdults("chicken fried rice", "And chicken fried rice for the adults. (ZZ TEST)"), true, "thread A in the model's shorter words");
    assert.equal(saidForTheAdults("Hawaiian pizza", "Hawaiian pizza for the kids, no pineapple on half. And chicken fried rice for the adults."), false);
    assert.equal(saidForTheAdults("Hawaiian pizza", "Hawaiian pizza please."), false);
    // The option a name stands for.
    const rice = setMenuItems[3] as any;
    assert.deepEqual(["Chicken", "Fried rice (Chicken)", "fried rice (shrimp)", "Beef"].map((n) => setMenuOptionOf(rice, n)), ["Chicken", "Chicken", "Shrimp", null]);
    assert.equal(setMenuOptionOf(setMenuItems[0] as any, null, "CF-31"), "Pepperoni", "an option's own code");
    // The approval refuses an adults' SET line it cannot place, and writes nothing.
    const refused = await approve(ev.both, {
      conversationId: null, messageId: null, package: null, setMenu: { templateId: cat.setMenu, choices: [] }, entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
      menuLines: [{ menu: "adults", itemName: "fried rice for the adults", quantity: 1, productCode: "CF-43", notes: null, setMenuItemId: RICE }],
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.message, 'Choose the adults\' option of "Fried rice" in the review.');
    assert.equal(await kitchenOf(ev.both), null, "nothing written");
  });

  // --- 2. "fried rice for the adults please" (thread B) is the same reading ---------------------
  await check("threadB_aSetMenuDishForTheAdultsIsNoChargedExtra", async () => {
    const res = await fill(ev.B);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(
      review.proposal.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.productCode, l.matchedName]),
      [["adults", RICE, "CF-43", null]],
      "the set menu's Fried rice for the adults, its option not named",
    );
    const state = initialReviewState(review, { fill: res.body.fill });
    assert.deepEqual([state.menuLines[0]?.price, state.menuLines[0]?.priceFrom], [null, null], "not the till's 240");
    assert.equal(undecidedOptions(state), 1, "the option holds Approve until staff pick one");
    const page = html(review, state);
    assert.ok(page.includes("Which option? The chat does not say: choose it before approving."));
    assert.ok(page.includes(esc(adultsSetMenuLineWords("Fried rice"))));
    const picked = { ...state, menuLines: state.menuLines.map((l) => ({ ...l, matchedName: "Fried rice (Shrimp)", changed: true })) };
    assert.equal(undecidedOptions(picked), 0);
    const ok = await approve(ev.B, approveBodyOf(review, picked, { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const plan = await kitchenOf(ev.B);
    assert.equal(plan.menus.adultsDiffer, true);
    const adults = (plan.menus.adults as any[]).map((l) => [l.itemName, l.source, l.groupId ?? null, l.price]);
    assert.deepEqual(adults.at(-1), ["Shrimp", "set_menu", RICE, 0], "the adults' Fried rice: Shrimp, a SET line");
    assert.equal((plan.menus.adults as any[]).some((l) => l.source === "additional"), false, "no EXTRA");
    const lines = await viewLinesOf(ev.B);
    assert.deepEqual(lines.filter((l) => l.source === "extra"), [], `nothing charged: ${JSON.stringify(lines)}`);
  });

  await check("anExtraOnlyWhenMoreIsAskedOrPricedOrCounted", async () => {
    const read = (text: string, line: Record<string, unknown>) =>
      resolveCatalogueAnswer(
        { setMenu: { templateId: cat.setMenu, line: 1, choices: [{ itemId: PIZZA, option: "Margherita", said: "Margherita", line: 1 }] }, menuLines: [{ menu: "adults", line: 1, ...line }], event: counts(14, 10) },
        catalogue,
        refsOf([text]),
      ).menuLines.map((l) => [l.setMenuItemId ?? null, l.quantity, l.chatPrice]);
    assert.deepEqual(read("Margherita for the kids, fried rice for the adults at 300.", { productCode: "CF-43", itemName: "fried rice", chatPrice: 300 }), [[null, 1, 300]], "a price named: an EXTRA");
    assert.deepEqual(read("Margherita for the kids, and 2 more fried rice for the adults.", { productCode: "CF-43", itemName: "2 more fried rice", quantity: 2 }), [[null, 2, null]], "more asked: an EXTRA");
    assert.deepEqual(read("Margherita for the kids, 6 fried rice for the adults.", { productCode: "CF-43", itemName: "6 fried rice", quantity: 6 }), [[null, 6, null]], "a count that is not the table's: an EXTRA");
    assert.deepEqual(read("Margherita for the kids, fried rice for the 10 adults.", { productCode: "CF-43", itemName: "fried rice", quantity: 10 }), [[RICE, 10, null]], "the adults' headcount: their SET line");
    assert.deepEqual(read("Margherita for the kids, a Pepperoni pizza for the adults.", { productCode: "CF-31", itemName: "a Pepperoni pizza" }), [[PIZZA, 1, null]], "another option of a choice group: the adults' SET line");
    assert.deepEqual(read("Margherita for the kids, a Caesar salad for the adults.", { productCode: "CF-15", itemName: "a Caesar salad" }), [[null, 1, null]], "a dish no set menu gives: an EXTRA");
    // Thread D, exactly as SCRUM-946 proved it: the adults' own 3 more Margherita, CF-24, charged.
    const res = await fill(ev.D);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(
      review.proposal.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.productCode, l.quantity, l.chatPrice]),
      [["kids", null, "CF-24", 2, 450], ["adults", null, "CF-24", 3, null]],
    );
    const state = initialReviewState(review, { fill: res.body.fill });
    const ok = await approve(ev.D, approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const plan = await kitchenOf(ev.D);
    assert.equal(plan.menus.adultsDiffer, true);
    assert.deepEqual(
      (plan.menus.adults as any[]).filter((l) => l.source !== "set_menu").map((l) => [l.itemName, l.quantity, l.productCode, l.price, l.source]),
      [["Margherita", 3, "CF-24", 400, "additional"]],
      "the adults' own EXTRA x3 with code CF-24, at the till's price",
    );
    const extras = (await viewLinesOf(ev.D)).filter((l) => l.source === "extra").map((l) => [l.name, l.qty, l.unit_price_satang, l.audience ?? null]);
    assert.deepEqual(extras, [["Margherita", 2, 45000, null], ["Margherita", 3, 40000, "adults"]], "both charged, as before");
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

console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== CHECKS ? 1 : 0);
