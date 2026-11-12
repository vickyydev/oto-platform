// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub inbox, a stub till menu) and needs a
// database whose otoapp schema the app's migrator has built. It renders the
// review's own component and the family's link list, so it runs with
// TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-970 (the open points of SCRUM-958 and SCRUM-946, from the staging
// proof docs/qa/proof-2026-11-13/SCRUM-958): the lane's checks passed with
// SCRIPTED answers, but on staging the real read returned the same chat in
// ANOTHER SHAPE, and two things staff must be told never appeared. So each
// case is checked in every shape of answer: the shape SCRUM-958's checks
// scripted and the shapes staging returned (receipt.json, points 5 and 7).
//   1. thread G, "The adults will eat the same as the kids, the Margherita
//      pizza for them too.": the fold is recorded from the chat's own words
//      — whether the read gave an adults' line, the words as the kids'
//      set-menu choice, a kids' line, or nothing — the review shows the note
//      with the chat's words, the toast ends with its sentence, and changing
//      the kids' choice brings the adults' own SET line; a sentence naming
//      no dish is said once, and only about food; words giving the adults
//      something else are not a fold, and "for them" is the adults when the
//      sentence names them first. One more wording ("Same Hawaiian pizza for
//      the adults too").
//   2. thread I, "2 Margherita pizzas for 900": the chat's total is read from
//      its own words whether the read gave 900, no price, or a figure it
//      worked out; never a price each; a price for one stays the price, and
//      so does one said for each ("450/each", "450 for each one"). One more
//      wording ("3 Caesar salads, 1,050 baht in total"), Thai, Russian.
//   3. threads A and B: the adults' own SET line is written with its till
//      code (CF-43), the till's plan view reads it so; the family's link and
//      the till's kitchen edit keep it; the kids' choice coming to the same
//      dish makes it the kids' copy, uncoded, read once.
//   4. the BEO PDF prints what the editor's hint says for an EXTRA line.
//   5. the BEO PDF's dates are the park's.
//   6. the family's link lists the choices just sent; the BEO sheets carry a
//      hidden description.
//   7. the fill's activity row says the shape of the answer, in counts.
//
// Every model answer here is scripted (the proof's own words): no model key is used.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-fill-read-shapes.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-fill-read-shapes.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-970";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "info";

const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes, lockKitchenPlanMutation, kitchenPlanDbDataOf, writeKitchenPlanRow, barPlanDbDataOf, writeBarPlanRow } = await import("../server/beo-routes");
const { applyTillKitchenEdit } = await import("../server/lib/tillKitchenEdit");
const tillWriters = { lockKitchenPlanMutation, kitchenPlanDbDataOf, writeKitchenPlanRow, barPlanDbDataOf, writeBarPlanRow };
const { loadBeoCatalogue, chatTotalOf, adultsSameAsKidsFolds, figureSaidEach } = await import("../server/lib/beoCatalogueFill");
const { beoPdfHtml, parkDateOf } = await import("../server/pdf");
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, approvalResultWords, adultsFoldNoticeOf, withKidsChoice } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { adultsFoldedWords, adultsSetMenuLineWords, chatTotalWords } = await import("../shared/beoAiFill");
const { beoExtraChargeOf, beoExtraHintOf } = await import("../shared/beoExtras");
const { adultsSetCopiesUncoded } = await import("../shared/kitchenAdults");
const { submittedChoicesOf, SubmittedChoices } = await import("../client/src/pages/public/menu-select");
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
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
const CHECKS = 18;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const coreBranch = randomUUID();
const manager = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID() };
const PIZZA = "item_970_pizza";
const HOT = "item_970_hot_dish";
const RICE = "item_970_fried_rice";
const FRIES = "item_970_fries";
const STICKS = "item_970_sticks";
const BOOKED = "2099-12-05";

// The park's set menu as staging holds it (Birthday set menu, Central Floresta).
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian", "Pepperoni"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27", Pepperoni: "CF-31" } },
  { id: HOT, type: "choice_group", label: "Hot dish", options: ["Chicken schnitzel", "Fish fingers"], allowMultiple: false, optionProductCodes: {} },
  { id: FRIES, type: "always_included", label: "French fries", productCode: "CF-11" },
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, productCode: "CF-43", optionProductCodes: {} },
  { id: STICKS, type: "always_included", label: "Veggie sticks", productCode: "CF-53" },
];
const item = (code: string, name: string, category: string, station: "kitchen" | "bar", baht: number, weekend = baht): TillMenuItem => ({
  code, name, category, parentCategory: null, station, priceSatang: baht * 100, priceWeekendSatang: weekend * 100, beoOnly: false,
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

// The proof's own threads (proof.mjs): the family's first line, then its menu line.
const OPENER = "Hi, a party for ZZ Test Remy turning 6, Saturday 12 December 11:00-13:00, 12 kids and 8 adults. (ZZ TEST)";
const G = "The Floresta birthday package with the Margherita pizza for the kids. The adults will eat the same as the kids, the Margherita pizza for them too. (ZZ TEST)";
const G_WORDING = "The Floresta birthday package, Hawaiian pizza for the kids. Same Hawaiian pizza for the adults too. (ZZ TEST)";
const G_PLAIN = "The Floresta birthday package with the Margherita pizza for the kids. The adults will eat the same as the kids. (ZZ TEST)";
const G_ELSE = "The Floresta birthday package with the Margherita pizza for the kids. The adults the same as the kids, but chicken fried rice for them. (ZZ TEST)";
const I_OPENER = "Hi, a party for ZZ Test Noa turning 5, Sunday 27 December 14:00-16:00, 10 kids and 5 adults. (ZZ TEST)";
const I = "The Floresta birthday package, Hawaiian pizza for the kids. For the adults a Pepperoni pizza at 300 please, and 2 Margherita pizzas for 900. And 3 extra portions of French fries for the kids. (ZZ TEST)";
const I_WORDING = "The Floresta birthday package, Hawaiian pizza for the kids. And 3 Caesar salads for the adults, 1,050 baht in total. (ZZ TEST)";
const A = "We'd like the Floresta birthday package. Hawaiian pizza for the kids, no pineapple on half. And chicken fried rice for the adults. (ZZ TEST)";
const B = "The Floresta birthday package please, and fried rice for the adults please. I already transferred the 3,000 deposit. (ZZ TEST)";

const counts = (kids: number, adults: number) => ({ numChildren: { value: kids, line: 1 }, numAdults: { value: adults, line: 1 } });
const pkg = { templateId: cat.pkg, said: "The Floresta birthday package", line: 2 };
const kidsMargherita = { itemId: PIZZA, option: "Margherita", said: "the Margherita pizza for the kids", line: 2 };
const kidsHawaiian = { itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza for the kids", line: 2 };

/** Each case: its line, and the answer in each shape the read was seen to give. */
const SHAPES: Record<string, { opener: string; text: string; answers: Record<string, unknown> }> = {
  G: {
    opener: OPENER,
    text: G,
    answers: {
      // SCRUM-958's scripted shape: the adults' words as an adults' menu line.
      adultsLine: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsMargherita] }, menuLines: [{ productCode: "CF-24", itemName: "the Margherita pizza for them too", menu: "adults", quantity: 8, line: 2 }], event: counts(12, 8) },
      // Staging's shape: the adults' words as the set-menu choice itself, merged into the kids'.
      asChoice: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Margherita", said: "the Margherita pizza for them too", line: 2 }, kidsMargherita] }, menuLines: [], event: counts(12, 8) },
      // Staging's second read: nothing of the adults at all.
      dropped: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsMargherita] }, menuLines: [], event: counts(12, 8) },
      // The words as a kids' line, which the fill merges into the kids' choice.
      kidsLine: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsMargherita] }, menuLines: [{ productCode: "CF-24", itemName: "the Margherita pizza for them too", menu: "kids", quantity: 1, line: 2 }], event: counts(12, 8) },
      // The lane's reviews: the words as a kids' line at the adults' count. "For them" is the
      // adults (the sentence's subject): the fold, never an 8 x Margherita kids' EXTRA.
      kidsLineAtCount: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsMargherita] }, menuLines: [{ productCode: "CF-24", itemName: "the Margherita pizza for them too", menu: "kids", quantity: 8, line: 2 }], event: counts(12, 8) },
    },
  },
  Gw: {
    opener: OPENER,
    text: G_WORDING,
    answers: {
      adultsLine: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, menuLines: [{ productCode: "CF-27", itemName: "Same Hawaiian pizza for the adults too", menu: "adults", quantity: 1, line: 2 }], event: counts(12, 8) },
      asChoice: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian, { itemId: PIZZA, option: "Hawaiian", said: "Same Hawaiian pizza", line: 2 }] }, menuLines: [], event: counts(12, 8) },
      dropped: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, menuLines: [], event: counts(12, 8) },
    },
  },
  Gp: {
    opener: OPENER,
    text: G_PLAIN,
    answers: {
      dropped: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsMargherita] }, menuLines: [], event: counts(12, 8) },
    },
  },
  Ge: {
    opener: OPENER,
    text: G_ELSE,
    answers: {
      asChoice: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsMargherita, { itemId: RICE, option: "Chicken", said: "chicken fried rice for them", line: 2 }] }, menuLines: [], event: counts(12, 8) },
    },
  },
  I: {
    opener: I_OPENER,
    text: I,
    answers: {
      // SCRUM-958's scripted shape: the read gave the 900 as the line's price.
      priced: {
        package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, event: counts(10, 5),
        menuLines: [
          { productCode: "CF-31", itemName: "Pepperoni pizza", menu: "adults", quantity: 1, chatPrice: 300, line: 2 },
          { productCode: "CF-24", itemName: "Margherita pizzas", menu: "adults", quantity: 2, chatPrice: 900, line: 2 },
          { productCode: "CF-11", itemName: "3 extra portions of French fries", menu: "kids", quantity: 3, line: 2 },
        ],
      },
      // Staging's shape (receipt.json, point 7, margheritaAsRead): no price at all.
      unpriced: {
        package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, event: counts(10, 5),
        menuLines: [
          { productCode: "CF-31", itemName: "Pepperoni pizza", menu: "adults", quantity: 1, chatPrice: 300, line: 2 },
          { productCode: "CF-24", itemName: "Margherita pizzas", menu: "adults", quantity: 2, line: 2 },
          { productCode: "CF-11", itemName: "extra portions of French fries", menu: "kids", quantity: 3, line: 2 },
        ],
      },
      // A read that worked a price each out of the total (450): the chat never says it.
      halved: {
        package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, event: counts(10, 5),
        menuLines: [
          { productCode: "CF-31", itemName: "Pepperoni pizza", menu: "adults", quantity: 1, chatPrice: 300, line: 2 },
          { productCode: "CF-24", itemName: "2 Margherita pizzas for 900", menu: "adults", quantity: 2, chatPrice: 450, line: 2 },
        ],
      },
    },
  },
  Iw: {
    opener: I_OPENER,
    text: I_WORDING,
    answers: {
      unpriced: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, event: counts(10, 5), menuLines: [{ productCode: "CF-15", itemName: "Caesar salads", menu: "adults", quantity: 3, line: 2 }] },
      priced: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, event: counts(10, 5), menuLines: [{ productCode: "CF-15", itemName: "Caesar salads", menu: "adults", quantity: 3, chatPrice: 1050, line: 2 }] },
    },
  },
  A: {
    opener: OPENER,
    text: A,
    answers: {
      asChoice: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza for the kids", notes: "no pineapple on half", line: 2 }, { itemId: RICE, option: "Chicken", said: "chicken fried rice for the adults", line: 2 }] }, event: counts(12, 8) },
      adultsLine: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza for the kids", line: 2 }] }, menuLines: [{ productCode: "CF-43", itemName: "chicken fried rice", option: "Fried rice (Chicken)", menu: "adults", quantity: 1, line: 2 }], event: counts(12, 8) },
    },
  },
  B: {
    opener: OPENER,
    text: B,
    answers: {
      adultsLine: { package: pkg, menuLines: [{ productCode: "CF-43", itemName: "fried rice for the adults", menu: "adults", quantity: 1, line: 2 }], event: counts(10, 6) },
    },
  },
};
// The lane's reviews: a price said for each item ("450/each", "450 for each one") is the price,
// never a total for the line, whether the read gave it or not.
const SAID_EACH = ["450/each", "450 baht/each", "450/ea", "450 for each one"];
SAID_EACH.forEach((words, i) => {
  const margherita = { productCode: "CF-24", itemName: "Margherita pizzas", menu: "adults", quantity: 2, line: 2 };
  SHAPES[`Ie${i}`] = {
    opener: I_OPENER,
    text: `The Floresta birthday package, Hawaiian pizza for the kids. For the adults 2 Margherita pizzas for ${words} please. (ZZ TEST)`,
    answers: {
      priced: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, event: counts(10, 5), menuLines: [{ ...margherita, chatPrice: 450 }] },
      unpriced: { package: pkg, setMenu: { templateId: cat.setMenu, line: 2, choices: [kidsHawaiian] }, event: counts(10, 5), menuLines: [margherita] },
    },
  };
});

type Fill = { key: string; shape: string };
const EVENTS: Fill[] = [];
for (const [key, c] of Object.entries(SHAPES)) for (const shape of Object.keys(c.answers)) EVENTS.push({ key, shape });
const ev = Object.fromEntries(EVENTS.map((e) => [`${e.key}.${e.shape}`, randomUUID()])) as Record<string, string>;
const conv = Object.fromEntries(EVENTS.map((e) => [`${e.key}.${e.shape}`, randomUUID()])) as Record<string, string>;
const keyOfConversation = (id: string) => Object.keys(conv).find((k) => conv[k] === id);
let answerNow: unknown = null;

const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    if (call.system.includes("THE CONVERSATION")) return JSON.stringify({ catalogue: answerNow });
    return JSON.stringify({ summary: "ZZ plain" });
  },
};
const at = (i: number) => new Date(Date.UTC(2026, 10, 12, 19, 28 + i)).toISOString();
const inboxOf = (key: string): InboxRead => {
  const c = SHAPES[key.split(".")[0]!]!;
  const texts = [c.opener, c.text];
  return {
    ok: true,
    confirmation: {
      conversationId: conv[key]!, eventId: ev[key]!, message: null, scanned: texts.length,
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
    const key = keyOfConversation(conversationId);
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
/** Create BEO's fill of one case in one shape of answer. */
async function fill(key: string, shape: string) {
  answerNow = SHAPES[key]!.answers[shape];
  const res = await post(`/api/events/${ev[`${key}.${shape}`]}/beo/ai-fill/inbox`, { existingData: { event: { title: "ZZ TEST" } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { review: res.body.review as BeoAiReview, fill: res.body.fill };
}
const approve = (key: string, shape: string, body: unknown) => post(`/api/events/${ev[`${key}.${shape}`]}/beo/ai-fill/approve`, body);
const kitchenOf = async (eventId: string) => (await q("select * from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null;
const viewLinesOf = async (eventId: string) =>
  ((await q<{ kitchen_plan: { lines: Array<Record<string, any>> } }>("select kitchen_plan from otoapp_v.event_packages where event_id = $1", [eventId]))[0]?.kitchen_plan?.lines ?? []);
const html = (review: BeoAiReview, state: ReturnType<typeof initialReviewState>) =>
  renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
const ids = (review: BeoAiReview) => ({ conversationId: review.conversationId ?? null, messageId: null });
/** Words as the review renders them (React escapes quotes). */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
async function submitLink(eventId: string, chosen: Record<string, string>) {
  const token = `zz-970-${randomUUID()}`;
  const [had] = await q("select id from beo_set_menu_selections where event_id = $1", [eventId]);
  if (had) await q("update beo_set_menu_selections set token = $2, is_submitted = false, selections = null where id = $1", [had.id, token]);
  else await q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted, selections) values ($1, $2, $3, $4, false, null)", [randomUUID(), eventId, cat.setMenu, token]);
  const res = await fetch(`${base}/api/beo/set-menu-selections/public/${token}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selections: Object.entries(chosen).map(([groupId, option]) => ({ groupId, chosenOptions: [option] })) }),
  });
  assert.equal(res.status, 200, await res.text());
}

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 970 ${run}`, `zz-970-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, 'ZZ TEST Central Floresta 970', 'ZZ TEST', 'Asia/Bangkok', $3)", [park, tenant, coreBranch]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 970', 'manager', true, false)", [
    manager, `zz-970-${manager.slice(0, 8)}@example.com`,
  ]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Birthday set menu 970', $3)", [cat.setMenu, tenant, JSON.stringify(setMenuItems)]);
  await q(
    `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours,
       price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, set_menu_template_id, branch_id, sort_order)
     values ($1, $2, 'Birthday package 970', 1690000, 10, 4, -1, 3, 1690000, 2090000, 130000, 150000, $3, $4, 1)`,
    [cat.pkg, tenant, cat.setMenu, park],
  );
  for (const key of Object.keys(ev)) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, status, inbox_conversation_id, num_children, num_adults)
       values ($1, $2, $3, 'birthday', $4, $5, '14:00', '16:30', 'tentative', $6, 12, 8)`,
      [ev[key], tenant, park, `ZZ TEST 970 ${key}`, BOOKED, conv[key]],
    );
  }

  // --- 1. Thread G: the fold, in every shape the read gave --------------------------------------
  const G_QUOTE = "the Margherita pizza for them too";
  for (const shape of ["adultsLine", "asChoice", "dropped", "kidsLine", "kidsLineAtCount"] as const) {
    await check(`threadG_${shape}_theFoldIsSaidFromTheChatsWords`, async () => {
      const { review, fill: f } = await fill("G", shape);
      assert.deepEqual(review.proposal.menuLines, [], "the adults' list rightly stays empty");
      assert.deepEqual(review.proposal.setMenu?.choices.map((c) => [c.itemId, c.option]), [[PIZZA, "Margherita"]], "the kids' Margherita");
      assert.deepEqual(
        review.proposal.adultsFolded?.map((x) => [x.dish, x.itemId ?? null, x.option ?? null, x.from.source, x.from.line, x.from.quote]),
        [["Margherita", PIZZA, "Margherita", "family", 2, G_QUOTE]],
        "one fold, the dish and the chat's words",
      );
      const state = initialReviewState(review, { fill: f });
      assert.equal(adultsFoldNoticeOf(review, state), adultsFoldedWords(1));
      const page = html(review, state);
      const note = page.slice(page.indexOf('data-testid="text-ai-review-adults-folded"'));
      assert.ok(note.startsWith(`data-testid="text-ai-review-adults-folded">${esc(adultsFoldedWords(1))}`), "the note under the Kitchen Plan");
      assert.ok(note.includes(`The chat says “${G_QUOTE}”`), "with the chat's words as its reason");
      // The kids' pizza changed to Hawaiian: the adults' Margherita comes back as their own SET line; and back.
      const hawaiian = { ...state, ...withKidsChoice(review, state, PIZZA, ["Hawaiian"]) };
      assert.equal(adultsFoldNoticeOf(review, hawaiian), null, "the note goes");
      assert.deepEqual(
        hawaiian.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.productCode, l.matchedName, l.price]),
        [["adults", PIZZA, "CF-24", "Margherita", null]],
        "the adults' own Margherita SET line",
      );
      assert.ok(html(review, hawaiian).includes(esc(adultsSetMenuLineWords("Pizza"))));
      const again = { ...hawaiian, ...withKidsChoice(review, hawaiian, PIZZA, ["Margherita"]) };
      assert.deepEqual([adultsFoldNoticeOf(review, again), again.menuLines], [adultsFoldedWords(1), []], "folded again");
      // Approve: the toast ends with the sentence; the adults' list stays empty, the switch off.
      const body = approveBodyOf(review, state, ids(review));
      assert.equal(body.adultsFolded, 1);
      const ok = await approve("G", shape, body);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.written.adultsLinesFolded, 1);
      assert.ok(approvalResultWords(ok.body).endsWith(adultsFoldedWords(1)), approvalResultWords(ok.body));
      const plan = await kitchenOf(ev[`G.${shape}`]!);
      assert.deepEqual([plan.menus.adultsDiffer, plan.menus.adults], [false, []]);
      assert.deepEqual((plan.menus.kids as any[]).filter((l) => l.source !== "set_menu"), [], "no kids' EXTRA of the adults' words");
    });
  }

  await check("threadG_oneMoreWording_andTheShapesOfIt", async () => {
    for (const shape of ["adultsLine", "asChoice", "dropped"] as const) {
      const { review, fill: f } = await fill("Gw", shape);
      assert.deepEqual(review.proposal.menuLines, [], `${shape}: no adults' line`);
      assert.deepEqual(
        review.proposal.adultsFolded?.map((x) => [x.dish, x.itemId ?? null, x.option ?? null, x.from.line]),
        [["Hawaiian", PIZZA, "Hawaiian", 2]],
        `${shape}: the Hawaiian folded once`,
      );
      const state = initialReviewState(review, { fill: f });
      assert.equal(adultsFoldNoticeOf(review, state), adultsFoldedWords(1), shape);
      const ok = await approve("Gw", shape, approveBodyOf(review, state, ids(review)));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(approvalResultWords(ok.body).endsWith(adultsFoldedWords(1)), `${shape}: the toast`);
    }
  });

  await check("threadG_noDishNamed_isSaidOnce_andAnotherDishIsNoFold", async () => {
    // "The adults will eat the same as the kids." with no dish: said once, as the set menu.
    const { review, fill: f } = await fill("Gp", "dropped");
    assert.deepEqual(review.proposal.adultsFolded?.map((x) => [x.itemId ?? null, x.from.quote]), [[null, "The adults will eat the same as the kids"]]);
    const state = initialReviewState(review, { fill: f });
    assert.equal(adultsFoldNoticeOf(review, state), adultsFoldedWords(1));
    assert.ok(html(review, state).includes("The chat says “The adults will eat the same as the kids”"));
    const ok = await approve("Gp", "dropped", approveBodyOf(review, state, ids(review)));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(approvalResultWords(ok.body).endsWith(adultsFoldedWords(1)));
    // "...the same as the kids, but chicken fried rice for them": the adults get something else, no fold.
    const other = await fill("Ge", "asChoice");
    assert.equal(other.review.proposal.adultsFolded, undefined, "no fold");
    // The lane's reviews: "for them" is the adults (the sentence's subject): the Chicken is the
    // adults' own SET line; the kids' Fried rice stays unchosen, never the adults' dish.
    assert.deepEqual(other.review.proposal.setMenu?.choices.map((c) => [c.itemId, c.option]), [[PIZZA, "Margherita"]], "the kids' Fried rice unchosen");
    assert.deepEqual(
      other.review.proposal.menuLines.map((l) => [l.menu, l.setMenuItemId ?? null, l.productCode, l.matchedName]),
      [["adults", RICE, "CF-43", "Fried rice (Chicken)"]],
      "the adults' own Chicken SET line",
    );
    // Pure: the Thai and Russian forms, a denial, a dish no set menu gives, a headcount.
    const menu = { name: "Birthday set menu 970", items: other.review.catalogue.setMenus.find((m) => m.id === cat.setMenu)!.items };
    const said = (text: string, choices = [{ itemId: PIZZA, option: "Margherita" }]) =>
      adultsSameAsKidsFolds([{ text, from: { source: "family", at: at(1), line: 2 } }], menu, choices, [], []).map((x) => [x.dish, x.itemId ?? null]);
    assert.deepEqual(said("พิซซ่ามาการิต้าสำหรับเด็ก ผู้ใหญ่ทานเหมือนเด็กค่ะ"), [["Birthday set menu 970", null]], "Thai");
    assert.deepEqual(said("Детям пиццу Маргарита. Взрослым то же самое, что и детям."), [["Birthday set menu 970", null]], "Russian");
    assert.deepEqual(said("Margherita for the kids, and the Margherita for the adults as well."), [["Margherita", PIZZA]], "for the adults as well");
    assert.deepEqual(said("The french fries for the grown-ups too."), [["French fries", null]], "a dish the set menu always gives");
    assert.deepEqual(said("The adults will not eat the same as the kids."), [], "a denial");
    assert.deepEqual(said("The adults also want a Caesar salad."), [], "a dish of their own");
    assert.deepEqual(said("Pepperoni pizza for the adults too."), [], "another option than the kids'");
    assert.deepEqual(said("12 kids and 8 adults, the same day as last year."), [], "a headcount");
    // The lane's reviews: a sentence naming no dish says the fold only about food.
    for (const notFood of [
      "Can the adults eat at the same time as the kids?",
      "Do adults pay the same as the kids?",
      "Is the adults' entrance the same price as the kids?",
      "Can the adults sit at the same table as the kids?",
      "Our adults are the same age group as last time",
      "12 kids, 8 adults too.",
    ]) {
      assert.deepEqual(said(notFood), [], notFood);
    }
    assert.deepEqual(said("The adults will have the same as the kids."), [["Birthday set menu 970", null]], "have the same");
    assert.deepEqual(said("Same food for the adults please."), [["Birthday set menu 970", null]], "same food");
    assert.deepEqual(said("Margherita for the kids. The adults the same."), [["Birthday set menu 970", null]], "the same, nothing else");
    assert.deepEqual(said("Margherita for the kids. For the adults too."), [["Birthday set menu 970", null]], "only them");
    const twice = adultsSameAsKidsFolds(
      [
        { text: "Margherita for the kids and the Margherita for the adults too.", from: { source: "family", at: at(1), line: 2 } },
        { text: "Confirmed: the Margherita for the kids, the Margherita for the adults as well.", from: { source: "team", at: at(2), line: 3 } },
      ],
      menu,
      [{ itemId: PIZZA, option: "Margherita" }],
      [],
      [],
    );
    assert.deepEqual(twice.map((x) => [x.dish, x.from.line]), [["Margherita", 2]], "the family's words and the team's confirming them: one fold");
  });

  // --- 2. Thread I: the chat's total, in every shape the read gave ------------------------------
  for (const shape of ["priced", "unpriced", "halved"] as const) {
    await check(`threadI_${shape}_theChatsTotalIsNamed`, async () => {
      const { review, fill: f } = await fill("I", shape);
      const margherita = review.proposal.menuLines.find((l) => l.productCode === "CF-24")!;
      assert.deepEqual([margherita.chatPrice, margherita.chatTotal, margherita.quantity], [null, { amount: 900, quantity: 2 }, 2], "never a price each");
      const pepperoni = review.proposal.menuLines.find((l) => l.productCode === "CF-31")!;
      assert.deepEqual([pepperoni.chatPrice, pepperoni.chatTotal ?? null], [300, null], "a price said for one stays the price");
      const state = initialReviewState(review, { fill: f });
      const line = state.menuLines.find((l) => l.productCode === "CF-24")!;
      assert.deepEqual([line.price, line.priceFrom], [400, "till"], "written at the till's price each");
      const page = html(review, state);
      assert.ok(page.includes(esc("The chat says ฿900 for 2; the till's price is ฿400 each.")), "the reason names the 900");
      assert.equal(chatTotalWords({ amount: 900, quantity: 2 }, 400), "The chat says ฿900 for 2; the till's price is ฿400 each.");
      const ok = await approve("I", shape, approveBodyOf(review, state, ids(review)));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const adults = ((await kitchenOf(ev[`I.${shape}`]!)).menus.adults as any[]).filter((l) => l.source !== "set_menu").map((l) => [l.itemName, l.quantity, l.price]);
      assert.deepEqual(adults, [["Pepperoni", 1, 300], ["Margherita", 2, 400]], "2 at 400 each, never 900 or 450 each");
    });
  }

  await check("threadI_oneMoreWording_thaiAndRussian", async () => {
    for (const shape of ["unpriced", "priced"] as const) {
      const { review, fill: f } = await fill("Iw", shape);
      const caesar = review.proposal.menuLines.find((l) => l.productCode === "CF-15")!;
      assert.deepEqual([caesar.chatPrice, caesar.chatTotal], [null, { amount: 1050, quantity: 3 }], shape);
      const state = initialReviewState(review, { fill: f });
      assert.ok(html(review, state).includes(esc("The chat says ฿1,050 for 3; the till's price is ฿370 each.")), shape);
    }
    const total = (text: string, names: string[], quantity: number) => chatTotalOf(text, names, quantity);
    assert.deepEqual(total("2 пиццы маргарита за 900 бат", ["пиццы маргарита", "Margherita"], 2), { amount: 900, quantity: 2 }, "Russian");
    assert.deepEqual(total("พิซซ่ามาการิต้า 2 ถาด รวม 900 บาท", ["พิซซ่ามาการิต้า"], 2), { amount: 900, quantity: 2 }, "Thai");
    assert.deepEqual(total("2 Margherita pizzas, 900 for both", ["Margherita pizzas"], 2), { amount: 900, quantity: 2 });
    assert.deepEqual(total("900 THB for 2 Margherita", ["Margherita"], 2), { amount: 900, quantity: 2 });
    assert.deepEqual(total("2 Margherita pizzas, all for ฿900", ["Margherita pizzas"], 2), { amount: 900, quantity: 2 });
    assert.deepEqual(total("All for ฿900: 2 Margherita pizzas", ["Margherita pizzas"], 2), { amount: 900, quantity: 2 });
    assert.equal(total("2 more Margherita pizzas at 450 each", ["Margherita pizzas"], 2), null, "a price each");
    assert.equal(total("2 Margherita pizzas по 450", ["Margherita pizzas"], 2), null, "по: each");
    assert.equal(total("an extra Margherita pizza for 450", ["Margherita pizza"], 1), null, "one item: a price");
    assert.equal(total("3 Margherita pizzas for 20 kids", ["Margherita pizzas"], 3), null, "a headcount");
    assert.equal(total("2 Margherita pizzas for 14:00", ["Margherita pizzas"], 2), null, "a time");
  });

  await check("threadI_aPriceSaidForEach_staysThePrice_inEveryShape", async () => {
    // The lane's reviews: "2 Margherita pizzas for 450/each" (and "450 baht/each", "450/ea", "450
    // for each one") is a price for each: kept as the line's price when the read gives it, never
    // a total; with no price read, no total and no "฿450 for 2" either, as before the lane.
    for (let i = 0; i < SAID_EACH.length; i++) {
      for (const shape of ["priced", "unpriced"] as const) {
        const label = `${SAID_EACH[i]} ${shape}`;
        const { review, fill: f } = await fill(`Ie${i}`, shape);
        const margherita = review.proposal.menuLines.find((l) => l.productCode === "CF-24")!;
        assert.deepEqual([margherita.chatPrice, margherita.chatTotal ?? null, margherita.quantity], [shape === "priced" ? 450 : null, null, 2], label);
        const state = initialReviewState(review, { fill: f });
        const line = state.menuLines.find((l) => l.productCode === "CF-24")!;
        assert.deepEqual([line.price, line.priceFrom], shape === "priced" ? [450, "chat"] : [400, "till"], label);
        assert.equal(html(review, state).includes(esc("The chat says ฿450 for 2")), false, `${label}: no total said`);
        if (shape !== "priced") continue;
        const ok = await approve(`Ie${i}`, shape, approveBodyOf(review, state, ids(review)));
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const adults = ((await kitchenOf(ev[`Ie${i}.${shape}`]!)).menus.adults as any[]).filter((l) => l.source !== "set_menu").map((l) => [l.itemName, l.quantity, l.price]);
        assert.deepEqual(adults, [["Margherita", 2, 450]], `${label}: 2 at 450 each`);
      }
      assert.equal(chatTotalOf(SHAPES[`Ie${i}`]!.text, ["Margherita pizzas"], 2), null, SAID_EACH[i]);
      assert.equal(figureSaidEach(SHAPES[`Ie${i}`]!.text, 450), true, SAID_EACH[i]);
    }
    assert.equal(figureSaidEach("พิซซ่ามาการิต้า ถาดละ 450 บาท", 450), true, "ถาดละ: each");
    assert.equal(figureSaidEach("พิซซ่ามาการิต้า 2 ถาด และเฟรนช์ฟรายส์ รวม 900 บาท", 900), false, "และ is 'and', never 'each'");
    assert.equal(figureSaidEach(I, 900), false, "thread I's 900 is a total");
  });

  // --- 3. Threads A and B: the adults' own SET line keeps its till code ---------------------------
  await check("threadsAB_theAdultsSetLineIsWrittenWithItsTillCode_andTheTillReadsIt", async () => {
    for (const shape of ["asChoice", "adultsLine"] as const) {
      const { review, fill: f } = await fill("A", shape);
      const state = initialReviewState(review, { fill: f });
      const ok = await approve("A", shape, approveBodyOf(review, state, ids(review)));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const plan = await kitchenOf(ev[`A.${shape}`]!);
      const chicken = (plan.menus.adults as any[]).find((l) => l.groupId === RICE);
      assert.deepEqual(
        [chicken?.itemName, chicken?.source, chicken?.productCode, chicken?.price, chicken?.included, chicken?.notes],
        ["Chicken", "set_menu", "CF-43", 0, true, "(Fried rice)"],
        `${shape}: the adults' Fried rice: Chicken with the set menu's code, a SET line`,
      );
      assert.equal((plan.menus.kids as any[]).some((l) => l.groupId === RICE), false, "nothing chosen for the kids' Fried rice");
      // The till's plan view: the line named and coded as the kids' dish of the set menu, never charged.
      const lines = await viewLinesOf(ev[`A.${shape}`]!);
      const seen = lines.find((l) => l.name === "Chicken");
      assert.deepEqual(
        [seen?.source, seen?.product_code, seen?.audience, seen?.unit_price_satang ?? null],
        ["set_menu", "CF-43", "adults", null],
        JSON.stringify(lines),
      );
      assert.deepEqual(lines.filter((l) => l.source === "extra"), [], "no EXTRA");
    }
    // Thread B: the option chosen by staff in the review (Shrimp), the same code.
    const { review, fill: f } = await fill("B", "adultsLine");
    const state = initialReviewState(review, { fill: f });
    const picked = { ...state, menuLines: state.menuLines.map((l) => ({ ...l, matchedName: "Fried rice (Shrimp)", changed: true })) };
    const ok = await approve("B", "adultsLine", approveBodyOf(review, picked, ids(review)));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const shrimp = ((await kitchenOf(ev["B.adultsLine"]!)).menus.adults as any[]).find((l) => l.groupId === RICE);
    assert.deepEqual([shrimp?.itemName, shrimp?.productCode, shrimp?.source], ["Shrimp", "CF-43", "set_menu"]);
    const view = (await viewLinesOf(ev["B.adultsLine"]!)).find((l) => l.name === "Shrimp");
    assert.deepEqual([view?.product_code, view?.audience], ["CF-43", "adults"]);
  });

  await check("theFamilysLinkAndTheTillsEditKeepTheCode_untilTheKidsHaveTheSameDish", async () => {
    const riceOf = (lines: any[]) => lines.filter((l) => l.groupId === RICE).map((l) => [l.itemName, l.productCode ?? null]);
    // Thread A approved (Chicken for the adults, nothing for the kids). The family's link: Veggie for the kids.
    const eA = ev["A.asChoice"]!;
    await submitLink(eA, { [PIZZA]: "Hawaiian", [HOT]: "Fish fingers", [RICE]: "Veggie" });
    let plan = await kitchenOf(eA);
    assert.deepEqual([riceOf(plan.menus.kids), riceOf(plan.menus.adults)], [[["Veggie", null]], [["Chicken", "CF-43"]]], "the family's link keeps it");
    // The till's kitchen edit changes the kids' choice to Shrimp: the adults' Chicken keeps its code.
    const till = await applyTillKitchenEdit(db, tillWriters, { id: eA, tenantId: tenant }, {
      id: randomUUID(), editedAt: new Date().toISOString(), by: { name: "ZZ Noi", role: "Manager" },
      changes: [{ op: "choose", choiceGroup: "Fried rice", lineId: (plan.menus.kids as any[]).find((l) => l.groupId === RICE).id, option: "Shrimp" }],
    });
    assert.equal(till.ok, true, JSON.stringify(till));
    plan = await kitchenOf(eA);
    assert.deepEqual([riceOf(plan.menus.kids), riceOf(plan.menus.adults)], [[["Shrimp", null]], [["Chicken", "CF-43"]]], "the till's edit keeps it");
    let lines = await viewLinesOf(eA);
    assert.deepEqual(lines.filter((l) => l.name === "Chicken").map((l) => [l.product_code, l.audience]), [["CF-43", "adults"]]);
    // The family now chooses Chicken for the kids too: the adults' line is the kids' dish, read once.
    await submitLink(eA, { [PIZZA]: "Hawaiian", [HOT]: "Fish fingers", [RICE]: "Chicken" });
    plan = await kitchenOf(eA);
    assert.deepEqual([riceOf(plan.menus.kids), riceOf(plan.menus.adults)], [[["Chicken", null]], [["Chicken", null]]], "uncoded, as the kids' copy");
    lines = await viewLinesOf(eA);
    assert.deepEqual(lines.filter((l) => l.audience === "adults"), [], `no second Chicken for the adults: ${JSON.stringify(lines)}`);
    assert.deepEqual(lines.filter((l) => l.choice_group === "Fried rice").map((l) => [l.chosen_option, l.product_code]), [["Chicken", "CF-43"]]);
    // Thread B through the till: the kids' Fried rice chosen Shrimp, the adults' own option: uncoded too.
    const eB = ev["B.adultsLine"]!;
    const edit = await applyTillKitchenEdit(db, tillWriters, { id: eB, tenantId: tenant }, {
      id: randomUUID(), editedAt: new Date().toISOString(), by: { name: "ZZ Noi", role: "Manager" },
      changes: [{ op: "choose", choiceGroup: "Fried rice", lineId: null, option: "Shrimp" }],
    });
    assert.equal(edit.ok, true, JSON.stringify(edit));
    const planB = await kitchenOf(eB);
    assert.deepEqual(riceOf(planB.menus.adults), [["Shrimp", null]], "the till's choice makes it the kids' dish");
    // Pure: another option stays coded; a line with no group is left as it is.
    const kids = [{ itemName: "Veggie", source: "set_menu", groupId: RICE }];
    assert.deepEqual(
      adultsSetCopiesUncoded(kids, [
        { itemName: "Chicken", source: "set_menu", groupId: RICE, productCode: "CF-43" },
        { itemName: "Veggie", source: "set_menu", groupId: RICE, productCode: "CF-43" },
        { itemName: "Margherita", source: "additional", productCode: "CF-24" },
      ]).map((l) => l.productCode ?? null),
      ["CF-43", null, "CF-24"],
    );
  });

  // --- 4 and 5. The BEO PDF: what an EXTRA costs, the park's dates ------------------------------
  await check("theBeoPdfSaysWhatAnExtraCostsAsTheEditorDoes", async () => {
    const byCode = new Map([
      ["CF-31", { priceSatang: 42_000, priceWeekendSatang: 42_000 }],
      ["CF-24", { priceSatang: 40_000, priceWeekendSatang: 45_000 }],
      ["CF-58-4", { priceSatang: 14_500, priceWeekendSatang: 15_500 }],
      ["PARTY-B73D949A", { priceSatang: 12_000, priceWeekendSatang: 12_000 }],
    ]);
    const SATURDAY = "2026-12-05";
    const kids = [
      { quantity: 1, itemName: "Margherita", notes: "(Pizza)", source: "set_menu", groupId: PIZZA },
      { quantity: 2, itemName: "Margherita", source: "additional", productCode: "CF-24" },
      { quantity: 1, itemName: "Pepperoni", source: "additional", productCode: "CF-31", price: 120 },
      { quantity: 1, itemName: "ZZ TEST mango sticky rice", source: "additional" },
      { quantity: 1, itemName: "ZZ TEST bubble tea", source: "additional", productCode: "PARTY-B73D949A" },
    ];
    const adults = [{ quantity: 1, itemName: "Pepperoni pizza for us", source: "additional", productCode: "CF-31" }];
    const bar = [{ quantity: 1, itemName: "Latte", productCode: "CF-58-4" }, { quantity: 1, itemName: "Water" }];
    const pdf = (till: { known: boolean; byCode: Map<string, { priceSatang: number; priceWeekendSatang: number }> } | undefined, eventDate = SATURDAY) =>
      beoPdfHtml({
        eventTitle: "ZZ TEST 970", eventDate, startTime: "14:00", status: "upcoming",
        kitchenPlan: { required: true, setMenuEnabled: true, setMenuTemplateName: "ZZ TEST set", menus: { kids, adults, adultsDiffer: true } as any },
        barPlan: { items: bar },
        ...(till ? { extrasTill: till } : {}),
      } as Parameters<typeof beoPdfHtml>[0]);
    const read = await pdf({ known: true, byCode });
    /** The words of the price cell of the first row whose text starts as `row` says (tags aside). */
    const price = (page: string, row: RegExp) => {
      const at = page.search(row);
      assert.ok(at >= 0, `no row ${row}`);
      const open = page.indexOf('<td class="price-col">', at) + '<td class="price-col">'.length;
      return page.slice(open, page.indexOf("</td>", open)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    };
    assert.equal(price(read, />Margherita \(Pizza\)/), "SET", "a SET line");
    assert.equal(price(read, /2x<\/td>/), "EXTRA till price 450 (weekend)", "the till's weekend price, as the editor's hint");
    assert.equal(price(read, />Pepperoni(?:<| <span)/), "EXTRA 120฿ each", "the price entered, for each item");
    assert.equal(price(read, />ZZ TEST mango sticky rice/), "EXTRA not charged", "a typed dish the till does not sell");
    assert.equal(price(read, />ZZ TEST bubble tea/), "EXTRA till price 120 (weekend) (made for this party)");
    assert.equal(price(read, />Pepperoni pizza for us/), "EXTRA till price 420 (weekend)", "the adults' own EXTRA");
    const barPart = read.slice(read.indexOf("<h2>Bar Plan</h2>"));
    assert.equal(price(barPart, />Latte/), "EXTRA till price 155 (weekend)");
    assert.equal(price(barPart, />Water/), "EXTRA not charged");
    // The very words of the editor's hint (shared/beoExtras.ts), line by line.
    const ctx = { till: { known: true, byCode }, partyDate: SATURDAY };
    assert.equal(beoExtraHintOf(beoExtraChargeOf(kids[1]!, "food", ctx)), "till price 450 (weekend)");
    assert.equal(beoExtraHintOf(beoExtraChargeOf(kids[3]!, "food", ctx)), "not charged");
    // A weekday party: the weekday price.
    assert.equal(price(await pdf({ known: true, byCode }, "2026-12-02"), /2x<\/td>/), "EXTRA till price 400");
    // The till's menu not read: the coded line with no price prints its badge alone, as before.
    const unread = await pdf(undefined);
    assert.equal(price(unread, /2x<\/td>/), "EXTRA");
    assert.equal(price(unread, />Pepperoni(?:<| <span)/), "EXTRA 120฿ each");
    assert.equal(price(unread, />ZZ TEST mango sticky rice/), "EXTRA not charged");
  });

  await check("theBeoPdfPrintsTheParksDates", async () => {
    // Chosen at 02:28 on 13 November at the park (19:28 UTC on the 12th): the proof's "Received 12 Nov".
    const chosenAt = "2026-11-12T19:28:45.000Z";
    const pdf = (parkTimeZone?: string) =>
      beoPdfHtml({
        eventTitle: "ZZ TEST 970", eventDate: "2026-12-12", startTime: "11:00", status: "upcoming",
        kitchenPlan: {
          required: true, setMenuEnabled: true, setMenuTemplateName: "ZZ TEST set",
          setMenuSelectionStatus: { isSubmitted: true, submittedAt: chosenAt },
          menus: { kids: [{ quantity: 1, itemName: "Margherita", notes: "(Pizza)", source: "set_menu" }] },
        },
        ...(parkTimeZone ? { parkTimeZone } : {}),
      } as Parameters<typeof beoPdfHtml>[0]);
    assert.ok((await pdf("Asia/Bangkok")).includes("ZZ TEST set &mdash; Received 13 Nov"), "the park's day");
    assert.ok((await pdf()).includes("Received 13 Nov"), "no zone: the park group's default, Bangkok");
    assert.ok((await pdf("Europe/London")).includes("Received 12 Nov"), "another park's own clock");
    assert.ok((await pdf("Not/AZone")).includes("Received 13 Nov"), "a zone the clock does not know: the default");
    assert.equal(parkDateOf(new Date(chosenAt), "Asia/Bangkok"), "13/11/2026", "the footer's date, on the park's clock");
    assert.equal(parkDateOf(new Date(chosenAt), "Europe/London"), "12/11/2026");
    const footer = (await pdf("Asia/Bangkok")).match(/Generated (\d{2}\/\d{2}\/\d{4})/)?.[1];
    assert.equal(footer, parkDateOf(new Date(), "Asia/Bangkok"));
  });

  // --- 6. The family's link and the BEO sheets ----------------------------------------------------
  await check("theFamilysLinkListsTheChoicesJustSent_andTheSheetsAreDescribed", () => {
    const groups = [{ id: PIZZA, label: "Pizza" }, { id: HOT, label: "Hot dish" }, { id: RICE, label: "Fried rice" }];
    const sent = submittedChoicesOf(groups, { isSubmitted: false, selections: null }, { [PIZZA]: ["Margherita"], [RICE]: ["Veggie"] });
    assert.deepEqual(sent.map((c) => `${c.label}: ${c.chosen.join(", ")}`), ["Pizza: Margherita", "Fried rice: Veggie"], "just sent: the family's own");
    const markup = renderToStaticMarkup(React.createElement(SubmittedChoices, { choices: sent }));
    assert.ok(markup.includes('data-testid="list-submitted-choices"'), "the page's own list");
    assert.ok(markup.includes(`data-testid="text-submitted-choice-${PIZZA}"`) && markup.includes("Pizza: Margherita") && markup.includes("Fried rice: Veggie"));
    assert.ok(!markup.includes("<input") && !markup.includes("<button"), "read-only");
    const held = submittedChoicesOf(groups, { isSubmitted: true, selections: [{ groupId: PIZZA, chosenOptions: ["Hawaiian"] }] }, { [PIZZA]: ["Margherita"] });
    assert.deepEqual(held.map((c) => c.chosen), [["Hawaiian"]], "read back: what the team now holds");
    assert.equal(renderToStaticMarkup(React.createElement(SubmittedChoices, { choices: [] })), "", "nothing chosen: nothing listed");
    const page = readFileSync(new URL("../client/src/pages/public/menu-select.tsx", import.meta.url), "utf8");
    const received = page.slice(page.indexOf(">Selections Received!</h2>"));
    assert.ok(received.slice(0, 1200).includes("<SubmittedChoices choices={submittedChoicesOf(choiceGroups, data, submitted ? selections : null)} />"), "under Selections Received!");
    const events = readFileSync(new URL("../client/src/pages/studio/events.tsx", import.meta.url), "utf8");
    for (const opens of ["<BeoEventEditor", "<BeoDayOfView"]) {
      const atOpen = events.indexOf(opens);
      const sheet = events.slice(events.lastIndexOf("<SheetContent", atOpen), atOpen);
      assert.match(sheet, /<SheetDescription className="sr-only">[^<]+<\/SheetDescription>/, `${opens}: a hidden description inside its sheet`);
    }
  });

  // --- 7. The activity row says the shape of the answer -----------------------------------------
  await check("theFillsActivityRowSaysTheShapeOfTheAnswerInCounts", async () => {
    const shapeOf = async (key: string) => {
      const rows = await q("select metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at", [`%${ev[key]}%`]);
      const meta = rows.map((r) => JSON.parse(r.metadata_json)).find((m) => m.answerShape);
      assert.ok(meta, `${key}: a row with the shape`);
      for (const words of ["Margherita pizza", "for them too", "same as the kids", "chicken fried rice"]) {
        assert.ok(rows.every((r) => !String(r.metadata_json).toLowerCase().includes(words.toLowerCase())), `${key}: no "${words}"`);
      }
      return meta.answerShape;
    };
    assert.deepEqual(await shapeOf("G.asChoice"), {
      read: { choices: 2, kidsLines: 0, adultsLines: 0, barLines: 0, pricedLines: 0 },
      proposed: { choices: 1, kidsLines: 0, adultsLines: 0, adultsSetLines: 0, barLines: 0, folds: 1, chatTotals: 0 },
    });
    assert.deepEqual(await shapeOf("G.adultsLine"), {
      read: { choices: 1, kidsLines: 0, adultsLines: 1, barLines: 0, pricedLines: 0 },
      proposed: { choices: 1, kidsLines: 0, adultsLines: 0, adultsSetLines: 0, barLines: 0, folds: 1, chatTotals: 0 },
    });
    assert.deepEqual(await shapeOf("I.unpriced"), {
      read: { choices: 1, kidsLines: 1, adultsLines: 2, barLines: 0, pricedLines: 1 },
      proposed: { choices: 1, kidsLines: 1, adultsLines: 2, adultsSetLines: 0, barLines: 0, folds: 0, chatTotals: 1 },
    });
    assert.deepEqual((await shapeOf("A.asChoice")).proposed.adultsSetLines, 1);
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from activity_log where metadata_json like any($1::text[])", [events.map((e) => `%${e}%`)]).catch(() => undefined);
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
