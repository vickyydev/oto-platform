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
//      adults" is written exactly as SCRUM-946 proved it. The family's
//      set-menu link submitted after the approval keeps the adults' own
//      SET line, even where it changes the kids' choice of that group (a
//      choice made on the till first); the adults' copies follow it.
//   3. thread G, "The adults will eat the same as the kids, the Margherita
//      pizza for them too.": the fold is said, in the review (with the chat's
//      words) and in the toast after Approve; when staff change the kids'
//      choice away from it in the review, the note goes and the adults'
//      Margherita comes back as their own SET line. An adults' SET line's
//      count is the set menu's own, shown and not typed.
//   4. thread I, "2 Margherita pizzas for 900": written at the till's price
//      each, and the review names the chat's 900 in the line's reason.
//   6. the BEO's sheet has a title for screen readers (the proof's console
//      warning); the approval counts every line it writes with a till code
//      (beo-fill-till-menu.check.ts).
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
import { readFileSync } from "node:fs";

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
const { registerBeoRoutes, lockKitchenPlanMutation, kitchenPlanDbDataOf, writeKitchenPlanRow, barPlanDbDataOf, writeBarPlanRow } = await import("../server/beo-routes");
const { applyTillKitchenEdit } = await import("../server/lib/tillKitchenEdit");
const tillWriters = { lockKitchenPlanMutation, kitchenPlanDbDataOf, writeKitchenPlanRow, barPlanDbDataOf, writeBarPlanRow };
const { loadBeoCatalogue, resolveCatalogueAnswer, saidForTheAdults } = await import("../server/lib/beoCatalogueFill");
type TranscriptRef = import("../server/lib/beoCatalogueFill").TranscriptRef;
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, undecidedOptions, approvalResultWords, adultsFoldNoticeOf, foldedBeforeReviewOf, withKidsChoice } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { adultsFoldedWords, adultsFoldedOnOwnMenuWords, adultsSetMenuLineWords, chatTotalWords, setMenuOptionOf } = await import("../shared/beoAiFill");
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
const CHECKS = 11;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const coreBranch = randomUUID();
const manager = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID() };
const KEYS = ["A", "B", "B2", "D", "G", "Gkids", "Gown", "I", "both"] as const;
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
const threadOf = (key: Key): keyof typeof THREADS => (key === "Gown" || key === "Gkids" ? "G" : key === "both" ? "A" : key === "B2" ? "B" : key) as keyof typeof THREADS;
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
    assert.deepEqual([same.setMenu?.choices.map((c) => c.option), same.menuLines.length, same.adultsFolded?.map((f) => f.dish)], [["Chicken"], 0, ["Chicken"]]);
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
    // The lane's reviews: a label names whom its part is for; a joined audience names both; the
    // family writing is the parents.
    assert.equal(saidForTheAdults("chicken fried rice", "Kids: Hawaiian pizza. Adults: chicken fried rice."), true, "a label");
    assert.equal(saidForTheAdults("Hawaiian pizza", "Kids: Hawaiian pizza. Adults: chicken fried rice."), false);
    assert.equal(saidForTheAdults("chicken fried rice", "For the adults: chicken fried rice."), true, "a label with for");
    assert.equal(saidForTheAdults("chicken fried rice", "Adults: pizza, chicken fried rice."), true, "the label reaches past a comma");
    assert.equal(saidForTheAdults("Chicken fried rice", "Chicken fried rice for the adults and the kids"), false, "both, joined");
    assert.equal(saidForTheAdults("Chicken fried rice", "Chicken fried rice for both adults and kids."), false, "both, joined");
    assert.equal(saidForTheAdults("Hawaiian pizza", "The parents would like the Hawaiian pizza."), false, "the parents writing");
    assert.equal(saidForTheAdults("chicken fried rice", "Chicken fried rice for the parents' table, pizza for the kids."), true, "for the parents");
    const labelled = read(["Kids: Hawaiian pizza. Adults: chicken fried rice."], [
      { itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza", line: 1 },
      { itemId: RICE, option: "Chicken", said: "chicken fried rice", line: 1 },
    ]);
    assert.deepEqual(labelled.setMenu?.choices.map((c) => c.option), ["Hawaiian"], "the kids' pizza only");
    assert.deepEqual(labelled.menuLines.map((l) => [l.menu, l.setMenuItemId, l.matchedName]), [["adults", RICE, "Fried rice (Chicken)"]]);
    const joined = read(["Chicken fried rice for the adults and the kids please."], [{ itemId: RICE, option: "Chicken", said: "Chicken fried rice", line: 1 }]);
    assert.deepEqual([joined.setMenu?.choices.map((c) => c.option), joined.menuLines.length], [["Chicken"], 0], "the kids' choice, which the adults eat");
    // A headcount says how many come, never whom a dish is for; "for the 10 adults" does.
    const counted = read(["Package for 12 kids and 8 adults with chicken fried rice and margherita"], [
      { itemId: RICE, option: "Chicken", said: "chicken fried rice", line: 1 },
      { itemId: PIZZA, option: "Margherita", said: "margherita", line: 1 },
    ]);
    assert.equal(counted.menuLines.length, 0, "no adults' line");
    assert.deepEqual(counted.setMenu?.choices.map((c) => [c.itemId, c.option]), [[RICE, "Chicken"], [PIZZA, "Margherita"]], "both the kids' choices");
    const fries = resolveCatalogueAnswer(
      { setMenu: { templateId: cat.setMenu, line: 1, choices: [] }, menuLines: [{ productCode: "CF-11", itemName: "extra fries", menu: "kids", line: 1 }], event: counts(15, 10) },
      catalogue,
      refsOf(["We are 15 kids and 10 adults we'd like extra fries"]),
    );
    assert.deepEqual(fries.menuLines.map((l) => [l.menu, l.productCode]), [["kids", "CF-11"]], "the kids' extra fries stay the kids'");
    assert.equal(saidForTheAdults("жареный рис с курицей", "Праздник на 12 детей и 8 взрослых, жареный рис с курицей."), false);
    assert.equal(saidForTheAdults("ข้าวผัดไก่", "เด็ก 12 คน ผู้ใหญ่ 8 คน ข้าวผัดไก่"), false);
    assert.equal(saidForTheAdults("chicken fried rice", "12 kids and 8 adults, chicken fried rice for the 8 adults"), true, "for the 8 adults");
    assert.equal(saidForTheAdults("ข้าวผัดไก่", "ข้าวผัดไก่สำหรับผู้ใหญ่ 8 ท่าน"), true);
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

  // --- 1 and 2 after the approval: the family's set-menu link (the lane's reviews) ---------------
  await check("theFamilysLinkKeepsTheAdultsOwnSetLine", async () => {
    const submit = async (eventId: string, chosen: Record<string, string>) => {
      const token = `zz-958-${randomUUID()}`;
      await q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted, selections) values ($1, $2, $3, $4, false, null)", [
        randomUUID(), eventId, cat.setMenu, token,
      ]);
      const res = await fetch(`${base}/api/beo/set-menu-selections/public/${token}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selections: Object.entries(chosen).map(([groupId, option]) => ({ groupId, chosenOptions: [option] })) }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    const setLines = (lines: any[]) => lines.filter((l) => l.source === "set_menu").map((l) => [l.itemName, l.groupId]);
    // Thread B approved with Shrimp for the adults and nothing chosen for the kids: the family's link
    // stays open. The family then chooses through it, Veggie for the kids' Fried rice.
    await submit(ev.B, { [PIZZA]: "Margherita", [HOT]: "Fish fingers", [RICE]: "Veggie" });
    let plan = await kitchenOf(ev.B);
    assert.deepEqual(
      setLines(plan.menus.kids),
      [["Margherita", PIZZA], ["Fish fingers", HOT], ["French fries", FRIES], ["Veggie", RICE], ["Veggie sticks", STICKS]],
      "the family's choices for the kids",
    );
    assert.deepEqual(
      setLines(plan.menus.adults),
      [["Margherita", PIZZA], ["Fish fingers", HOT], ["French fries", FRIES], ["Veggie sticks", STICKS], ["Shrimp", RICE]],
      "the adults' copies follow the family's choices; their own Fried rice: Shrimp stays",
    );
    assert.equal(plan.menus.adultsDiffer, true);
    assert.deepEqual((await viewLinesOf(ev.B)).filter((l) => l.source === "extra"), [], "nothing charged");
    // The kids' choice of the very group the adults have their own dish in, changed by the link: an
    // approval as thread B's, the kids' Fried rice chosen on the till (Veggie), then the family's Chicken.
    const approved = await approve(ev.B2, {
      conversationId: null, messageId: null, package: null, setMenu: { templateId: cat.setMenu, choices: [] }, entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
      menuLines: [{ menu: "adults", itemName: "fried rice for the adults", quantity: 1, productCode: "CF-43", notes: null, setMenuItemId: RICE, option: "Fried rice (Shrimp)" }],
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const till = await applyTillKitchenEdit(db, tillWriters, { id: ev.B2, tenantId: tenant }, {
      id: randomUUID(), editedAt: new Date().toISOString(), by: { name: "ZZ Noi", role: "Manager" },
      changes: [{ op: "choose", choiceGroup: "Fried rice", lineId: null, option: "Veggie" }],
    });
    assert.equal(till.ok, true, JSON.stringify(till));
    const riceOf = (lines: any[]) => lines.filter((l) => l.groupId === RICE).map((l) => l.itemName);
    plan = await kitchenOf(ev.B2);
    assert.deepEqual([riceOf(plan.menus.kids), riceOf(plan.menus.adults)], [["Veggie"], ["Shrimp"]], "the till's choice is the kids'");
    await submit(ev.B2, { [PIZZA]: "Hawaiian", [HOT]: "Chicken schnitzel", [RICE]: "Chicken" });
    plan = await kitchenOf(ev.B2);
    assert.deepEqual([riceOf(plan.menus.kids), riceOf(plan.menus.adults)], [["Chicken"], ["Shrimp"]], "the kids' Fried rice is the family's Chicken; the adults' own Shrimp stays");
    assert.deepEqual(setLines(plan.menus.adults).map(([name]) => name), ["Hawaiian", "Chicken schnitzel", "French fries", "Veggie sticks", "Shrimp"]);
  });

  await check("anAdultsSetLinesCountIsTheSetMenusOwn", async () => {
    // Thread A's words: the adults' Fried rice: Chicken, a SET line. Approve and create writes it with
    // the set menu's own portions, so the review shows that count and takes none typed.
    const review: BeoAiReview = (await fill(ev.both)).body.review;
    const typed = initialReviewState(review, {});
    typed.menuLines = typed.menuLines.map((l) => ({ ...l, quantity: 8 }));
    const rowOf = (page: string) => {
      const from = page.slice(page.indexOf('data-testid="ai-review-menu-line"'));
      return from.slice(0, from.indexOf('data-testid="text-ai-review-match"'));
    };
    const row = rowOf(html(review, typed));
    assert.ok(row.includes('data-testid="text-ai-review-menu-set-qty">1</span>'), `the set menu's one portion, shown: ${row}`);
    assert.ok(!row.includes('type="number"'), "no count box to type in");
    // A set menu that names its portions ("Fried rice x3"): that count.
    const three: BeoAiReview = {
      ...review,
      catalogue: { ...review.catalogue, setMenus: review.catalogue.setMenus.map((m) => ({ ...m, items: m.items.map((i) => (i.id === RICE ? { ...i, qty: 3 } : i)) })) },
    };
    assert.ok(rowOf(html(three, typed)).includes('data-testid="text-ai-review-menu-set-qty">3</span>'), "the set menu's own count");
    // Any other line keeps its count box.
    const extra = { ...typed, menuLines: typed.menuLines.map(({ setMenuItemId: _set, ...l }) => l) };
    assert.ok(rowOf(html(review, extra)).includes('type="number"'), "an EXTRA's count is typed as before");
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
    // The lane's reviews: two adults' options of a group of one choice. The set menu gives them one
    // Fried rice: one SET line, the later; the other an EXTRA with its till code, at the till's price.
    const two = resolveCatalogueAnswer(
      {
        setMenu: { templateId: cat.setMenu, line: 1, choices: [{ itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza for the kids", line: 1 }] },
        menuLines: [
          { productCode: "CF-43", itemName: "chicken fried rice", option: "Chicken", menu: "adults", quantity: 1, line: 1 },
          { productCode: "CF-43", itemName: "shrimp fried rice", option: "Shrimp", menu: "adults", quantity: 1, line: 1 },
        ],
        event: counts(12, 8),
      },
      catalogue,
      refsOf(["Hawaiian pizza for the kids. For the adults chicken fried rice and shrimp fried rice."]),
    );
    assert.deepEqual(
      two.menuLines.map((l) => [l.matchedName, l.productCode, l.setMenuItemId ?? null]),
      [["Fried rice (Chicken)", "CF-43", null], ["Fried rice (Shrimp)", "CF-43", RICE]],
      "one SET line of Fried rice for the adults; the other an extra",
    );
    const twoReview: BeoAiReview = { ...(await fill(ev.both)).body.review, proposal: two };
    const twoState = initialReviewState(twoReview, {});
    assert.deepEqual(twoState.menuLines.map((l) => [l.matchedName, l.price, l.priceFrom]), [["Fried rice (Chicken)", 240, "till"], ["Fried rice (Shrimp)", null, null]]);
    // The approval refuses two such SET lines, and writes nothing.
    const twice = await approve(ev.both, {
      conversationId: null, messageId: null, package: null, setMenu: { templateId: cat.setMenu, choices: [] }, entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
      menuLines: [
        { menu: "adults", itemName: "chicken fried rice", quantity: 1, productCode: "CF-43", notes: null, setMenuItemId: RICE, option: "Fried rice (Chicken)" },
        { menu: "adults", itemName: "shrimp fried rice", quantity: 1, productCode: "CF-43", notes: null, setMenuItemId: RICE, option: "Fried rice (Shrimp)" },
      ],
    });
    assert.equal(twice.status, 400);
    assert.equal(twice.body.message, 'The set menu gives the adults one "Fried rice": keep one of its options in the review.');
    assert.equal(await kitchenOf(ev.both), null, "nothing written");
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

  // --- 3. A fold is said (thread G) -------------------------------------------------------------
  await check("threadG_aFoldIsSaidInTheReviewAndTheToast", async () => {
    const res = await fill(ev.G);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(review.proposal.menuLines, [], "the adults' list rightly stays empty");
    assert.deepEqual(review.proposal.adultsFolded?.map((f) => [f.dish, f.from.source, f.from.line, f.from.quote]), [["Margherita", "family", 2, "the Margherita pizza for them too"]]);
    const state = initialReviewState(review, { fill: res.body.fill });
    assert.equal(adultsFoldNoticeOf(review, state), adultsFoldedWords(1));
    const page = html(review, state);
    const note = page.slice(page.indexOf('data-testid="text-ai-review-adults-folded"'));
    assert.ok(note.startsWith(`data-testid="text-ai-review-adults-folded">${esc(adultsFoldedWords(1))}`), "the note under the Kitchen Plan");
    assert.ok(note.includes("The chat says “the Margherita pizza for them too”"), "with the chat's words as its reason");
    const body = approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null });
    assert.equal(body.adultsFolded, 1, "a count, never the chat's words");
    const ok = await approve(ev.G, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.written.adultsLinesFolded, 1);
    assert.equal(approvalResultWords(ok.body).includes(adultsFoldedWords(1)), true, "the toast says it");
    const plan = await kitchenOf(ev.G);
    assert.deepEqual([plan.menus.adultsDiffer, plan.menus.adults], [false, []], "the switch off, the adults' list empty");
    // Staff choosing another set menu in the review: the fold was decided against the proposed one, so nothing is said.
    const another = { ...state, setMenuId: { ...state.setMenuId, value: null, changed: true } };
    assert.equal(adultsFoldNoticeOf(review, another), null);
    assert.equal(approveBodyOf(review, another, ids).adultsFolded, undefined);
  });

  await check("threadG_aFoldGoesWhenTheKidsChoiceLeavesIt", async () => {
    // The lane's reviews: staff change the kids' pizza from Margherita to Hawaiian in the review. The
    // adults' words named the Margherita, so it no longer repeats the kids' menu: the note goes, and
    // the adults' Margherita comes back as their own SET line (point 1's shape), never lost.
    const res = await fill(ev.Gkids);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(review.proposal.adultsFolded?.map((f) => [f.dish, f.itemId ?? null, f.option ?? null]), [["Margherita", PIZZA, "Margherita"]], "the fold names the kids' choice it repeats");
    const opened = initialReviewState(review, { fill: res.body.fill });
    assert.equal(adultsFoldNoticeOf(review, opened), adultsFoldedWords(1));
    const state = { ...opened, ...withKidsChoice(review, opened, PIZZA, ["Hawaiian"]) };
    assert.deepEqual(state.choices[PIZZA]?.value, ["Hawaiian"]);
    assert.equal(adultsFoldNoticeOf(review, state), null, "the note goes");
    assert.deepEqual(foldedBeforeReviewOf(review, state), []);
    assert.deepEqual(
      state.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.productCode, l.matchedName, l.price, l.from?.quote ?? null]),
      [["adults", PIZZA, "CF-24", "Margherita", null, "the Margherita pizza for them too"]],
      "the adults' Margherita, their own SET line, with the chat's words as its reason",
    );
    const page = html(review, state);
    assert.ok(!page.includes('data-testid="text-ai-review-adults-folded"'), "no fold note");
    assert.ok(page.includes(esc(adultsSetMenuLineWords("Pizza"))), "the SET line's words");
    assert.ok(page.includes("The chat says “the Margherita pizza for them too”"));
    // The kids' Margherita again: folded again, the line gone; "Not chosen yet": the adults' own again.
    const back = { ...state, ...withKidsChoice(review, state, PIZZA, ["Margherita"]) };
    assert.deepEqual([adultsFoldNoticeOf(review, back), back.menuLines], [adultsFoldedWords(1), []]);
    const none = { ...back, ...withKidsChoice(review, back, PIZZA, []) };
    assert.deepEqual(none.menuLines.map((l) => l.matchedName), ["Margherita"]);
    // Approved with the kids' Hawaiian: the adults' own menu holds their Margherita as a SET line; no fold said.
    const body = approveBodyOf(review, state, ids);
    assert.equal(body.adultsFolded, undefined);
    assert.deepEqual(body.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.option ?? null]), [["adults", PIZZA, "Margherita"]]);
    const ok = await approve(ev.Gkids, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.written.adultsLinesFolded, undefined);
    assert.equal(approvalResultWords(ok.body).includes("only repeat"), false);
    const plan = await kitchenOf(ev.Gkids);
    assert.equal(plan.menus.adultsDiffer, true);
    const pizzaOf = (lines: any[]) => lines.filter((l) => l.groupId === PIZZA).map((l) => [l.itemName, l.source]);
    assert.deepEqual([pizzaOf(plan.menus.kids), pizzaOf(plan.menus.adults)], [[["Hawaiian", "set_menu"]], [["Margherita", "set_menu"]]]);
    assert.deepEqual((await viewLinesOf(ev.Gkids)).filter((l) => l.source === "extra"), [], "nothing charged");
  });

  await check("aFoldBesideTheAdultsOwnLineIsSaidSo", async () => {
    // Thread G's words with an adults' dish of their own: the folded Margherita is on their menu from the set menu.
    const review: BeoAiReview = (await fill(ev.Gown)).body.review;
    review.proposal = {
      ...review.proposal,
      menuLines: [{ menu: "adults", itemName: "a Caesar salad for the adults", quantity: 1, productCode: "CF-15", matchedName: "Caesar salad", notInMenu: false, chatPrice: null, from: { source: "family", at: at(1), line: 2 } }],
    };
    const state = initialReviewState(review, {});
    assert.equal(adultsFoldNoticeOf(review, state), adultsFoldedOnOwnMenuWords(1));
    const ok = await approve(ev.Gown, approveBodyOf(review, state, ids));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.written.adultsLinesFolded, ok.body.written.adultsMenuOwn], [1, true]);
    assert.equal(approvalResultWords(ok.body).includes(adultsFoldedOnOwnMenuWords(1)), true);
    const plan = await kitchenOf(ev.Gown);
    assert.deepEqual(
      (plan.menus.adults as any[]).map((l) => [l.itemName, l.source]),
      [["Margherita", "set_menu"], ["French fries", "set_menu"], ["Veggie sticks", "set_menu"], ["Caesar salad", "additional"]],
      "the Margherita from the set menu, never as an extra",
    );
  });

  // --- 4. A chat total is shown (thread I) ------------------------------------------------------
  await check("threadI_aChatTotalIsNamedInTheReason", async () => {
    const res = await fill(ev.I);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    const margherita = review.proposal.menuLines.find((l) => l.productCode === "CF-24")!;
    assert.deepEqual([margherita.chatPrice, margherita.chatTotal, margherita.setMenuItemId ?? null], [null, { amount: 900, quantity: 2 }, null], "2 for 900: no price each, the total kept, an EXTRA");
    const state = initialReviewState(review, { fill: res.body.fill });
    const line = state.menuLines.find((l) => l.productCode === "CF-24")!;
    assert.deepEqual([line.price, line.priceFrom], [400, "till"], "written at the till's price each");
    assert.equal(chatTotalWords({ amount: 900, quantity: 2 }, 400), "The chat says ฿900 for 2; the till's price is ฿400 each.");
    const page = html(review, state);
    assert.ok(page.includes("The chat says ฿900 for 2; the till&#x27;s price is ฿400 each."), "the reason names the chat's 900");
    // The Pepperoni at the chat's 300 and the extra fries are as before.
    const pepperoni = state.menuLines.find((l) => l.productCode === "CF-31")!;
    assert.deepEqual([pepperoni.price, pepperoni.priceFrom, pepperoni.setMenuItemId ?? null], [300, "chat", null]);
    const fries = state.menuLines.find((l) => l.productCode === "CF-11")!;
    assert.deepEqual([fries.quantity, fries.price, fries.priceFrom], [3, 175, "till"]);
    // A total for a dish the till does not price: the box is offered to type a price each.
    const noTill = { ...review, catalogue: { ...review.catalogue, till: [] } };
    const noTillState = initialReviewState(noTill, {});
    const noTillPage = html(noTill, noTillState);
    assert.ok(noTillPage.includes("The chat says ฿900 for 2; no price each is written: type one if you want."));
    const box = noTillPage.slice(noTillPage.indexOf("The chat says ฿900 for 2"));
    assert.ok(box.includes('data-testid="input-ai-review-menu-price"'), "the price box, to type one");
    const ok = await approve(ev.I, approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const adults = ((await kitchenOf(ev.I)).menus.adults as any[]).filter((l) => l.source !== "set_menu").map((l) => [l.itemName, l.quantity, l.price]);
    assert.deepEqual(adults, [["Pepperoni", 1, 300], ["Margherita", 2, 400]], "2 at 400 each, never 900 each, never 450 made up");
  });

  // --- 6. The BEO sheet's dialog has a title for screen readers (SCRUM-940 point 5) ---------------
  await check("theBeoSheetsHaveATitleForScreenReaders", () => {
    // The proof's console read "`DialogContent` requires a `DialogTitle`" on every BEO tab: the sheet
    // the BEO opens in (Radix's dialog) had none. A visually hidden one, nothing visible changes.
    const page = readFileSync(new URL("../client/src/pages/studio/events.tsx", import.meta.url), "utf8");
    for (const [opens, title] of [["<BeoEventEditor", "BEO editor"], ["<BeoDayOfView", "BEO day-of view"]] as const) {
      const at = page.indexOf(opens);
      const sheet = page.slice(page.lastIndexOf("<SheetContent", at), at);
      assert.ok(sheet.includes(`<SheetTitle className="sr-only">${title}</SheetTitle>`), `${title}: a hidden title inside its sheet`);
    }
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
