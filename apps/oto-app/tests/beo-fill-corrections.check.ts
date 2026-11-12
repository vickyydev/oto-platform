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
//   2. the chat's price for an extra dish ("2 more at 450 each") is written on
//      its line as an EXTRA at that price for each item, shown so in the
//      review; a cake's price stays where the form keeps it.
//   3. Fetch from chat compares by what is said, not by the wording: a line
//      the form already says (a lead-in such as "Important", the case and the
//      punctuation aside) is not offered again; each new line is offered on
//      its own and can be accepted alone.
//   4. a phone number the form holds (or the review offers) as the WhatsApp
//      number is not offered as a Special requests line too.
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
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
const { initialReviewState, approveBodyOf, menuLinePriceWords, namesPhone, NOTHING_HELD } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { fetchChangesOf, applyFetchChanges, rememberDeclined, offeredChanges, changeKey, saysAlready, NO_DECLINED } = await import("../client/src/lib/beo-fetch-from-chat");
const { emptyBeoAiDetails } = await import("../shared/beoAiFill");
type FetchFormValues = import("../client/src/lib/beo-fetch-from-chat").FetchFormValues;
type BeoAiProposal = import("../shared/beoAiFill").BeoAiProposal;
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
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
const CHECKS = 4;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
/** The park's till branch (`branches.core_branch_id`): the till's plan view and the till's menu are keyed by it. */
const coreBranch = randomUUID();
const manager = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID(), otherMenu: randomUUID(), bubble: randomUUID() };
const KEYS = ["extra", "mirror", "priced"] as const;
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
const fill = (eventId: string, existingData: Record<string, unknown> = { event: { title: "ZZ TEST" } }) =>
  post(`/api/events/${eventId}/beo/ai-fill/inbox`, { existingData });
const approve = (eventId: string, body: unknown) => post(`/api/events/${eventId}/beo/ai-fill/approve`, body);
const bodyOf = (over: Partial<BeoAiApproveBody>): BeoAiApproveBody => ({
  conversationId: null, messageId: null, package: null, setMenu: null, menuLines: [], entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [], ...over,
});
/** A family line of the chat, for a value's reason. */
const familyFrom = (line: number, quote?: string) => ({ source: "family" as const, at: at(line - 1), line, ...(quote ? { quote } : {}) });
/** A review read from the chat alone (no team confirmation), for the pure helpers. */
function reviewOf(over: Partial<BeoAiProposal> = {}, details: Partial<BeoAiProposal["details"]> = {}): BeoAiReview {
  return {
    origin: "inbox",
    proposal: {
      package: null, addOns: [], setMenu: null, menuLines: [], entertainment: [], otherLines: [], event: {}, cake: null, deposit: null,
      ...over,
      details: { ...emptyBeoAiDetails(), ...details },
    },
    catalogue: { packages: [], setMenus: [], entertainment: [], food: [] },
    finalMessage: null,
    ruling: null,
    conversationId: null,
    timeZone: "Asia/Bangkok",
    transcript: { lines: 5, cut: false },
    replaces: [],
    parentSelection: null,
  };
}
/** The form, empty but for what a check gives it. */
const formOf = (over: Partial<FetchFormValues> = {}): FetchFormValues => ({
  title: "ZZ TEST", childName: "", bookingName: "", numChildren: null, numAdults: null, startTime: "", endTime: "", eventDate: "",
  locationText: "", specialRequests: "", activities: "", decoration: "", setupReadyBy: "", setupResponsible: "",
  cakeMode: "NONE", cakeNotes: "", cakeTime: "", prepaymentReceived: 0, depositDate: "", packageName: "", packageNotes: "",
  whatsappPhoneRaw: "", kidTurningAge: null, setupNotes: "", cakeQuantity: 1, cakeIncluded: "", cakePrice: 0,
  kidsFoodTime: "", adultsFoodTime: "", barServiceTime: "",
  ...over,
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

  // --- 2. The chat's price on an extra dish ---------------------------------------------------
  await check("theChatsPriceIsWrittenOnTheLineForEachItem", async () => {
    chats.set("priced", [
      { id: `${conv.priced}-1`, author: "customer", at: at(0), text: "Hi, a party for ZZ Test Sami turning 8, Sunday 20 December 15:00-17:30, 14 kids and 10 adults. PRICED-946" },
      { id: `${conv.priced}-2`, author: "customer", at: at(1), text: "The Floresta birthday package. Margherita for the kids' set menu, and 2 more Margherita pizzas at 450 each. 2 of the park's cakes at 800 baht each. PRICED-946" },
    ]);
    answers.set("PRICED-946", {
      catalogue: {
        package: { templateId: cat.pkg, said: "The Floresta birthday package", line: 2 },
        setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Margherita", said: "Margherita", line: 2 }] },
        menuLines: [{ productCode: "CF-24", itemName: "2 more Margherita pizzas", menu: "kids", quantity: 2, chatPrice: 450, line: 2 }],
        cake: { mode: "INTERNAL", notes: "2 of the park's cakes", quantity: 2, price: 800, line: 2 },
        event: { numChildren: { value: 14, line: 1 } },
      },
    });
    const res = await fill(ev.priced);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    const state = initialReviewState(review, { fill: res.body.fill });
    const line = state.menuLines[0]!;
    assert.deepEqual([line.itemName, line.quantity, line.price, line.priceFrom], ["2 more Margherita pizzas", 2, 450, "chat"]);
    assert.equal(menuLinePriceWords(line), "THB each, written on the line as an EXTRA (2 × ฿450 = ฿900) — the chat's price.");
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
    assert.ok(html.includes('data-testid="input-ai-review-menu-price"') && html.includes('value="450"'), "the price shown in the review, editable");
    assert.ok(html.includes("THB each, written on the line as an EXTRA"), "with what Approve and create does with it");
    const body = approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null });
    assert.equal(body.menuLines[0]?.price, 450, "the approval carries the price shown");
    assert.equal(body.cake?.price, 800, "the cake's price rides where the form keeps it");
    const ok = await approve(ev.priced, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const plan = await kitchenOf(ev.priced);
    const extra = (plan.menus.kids as any[]).find((l) => l.source === "additional");
    assert.deepEqual([extra?.productCode ?? extra?.notes, extra?.quantity, extra?.price], ["CF-24", 2, 450], "an EXTRA at 450 for each item");
    assert.equal(plan.menus.cakePrice, 800, "the cake's price stays the form's cake price");
    assert.equal(plan.menus.kids.filter((l: any) => /cake/i.test(l.itemName)).length, 0, "no charge is invented for the cake");
    // The till's plan reads it as an EXTRA at 450 a portion.
    const tillLine = (await viewLinesOf(ev.priced)).find((l) => l.source === "extra" && l.line_id === extra?.id);
    assert.deepEqual([tillLine?.qty, tillLine?.unit_price_satang], [2, 45000], JSON.stringify(tillLine));
    // A price the reviewer clears is not written; one they change is.
    const cleared = approveBodyOf(review, { ...state, menuLines: state.menuLines.map((l) => ({ ...l, price: null, priceFrom: "staff" as const })) }, { conversationId: null, messageId: null });
    assert.equal(cleared.menuLines[0]?.price, undefined);
    const changed = { ...state, menuLines: state.menuLines.map((l) => ({ ...l, price: 420, priceFrom: "staff" as const })) };
    assert.equal(approveBodyOf(review, changed, { conversationId: null, messageId: null }).menuLines[0]?.price, 420);
    assert.ok(menuLinePriceWords(changed.menuLines[0]!).endsWith("— changed here."));
  });

  // --- 3. Fetch from chat: nothing offered twice, each new line on its own --------------------
  await check("fetchFromChatComparesByWhatIsSaid", () => {
    const held = "Allergy: she is allergic to peanuts\nZZ typed by staff: grandma needs a seat near the door";
    // The proof's fetch 4: the same allergy with a lead-in, a new one, and the new one said twice.
    const review = reviewOf({}, {
      requests: [
        { kind: "allergy", text: "Important: she is allergic to peanuts", from: familyFrom(4) },
        { kind: "allergy", text: "one of the kids is lactose intolerant", from: familyFrom(5) },
        { kind: "special_request", text: "Also: one of the kids is lactose intolerant!", from: familyFrom(5) },
        { kind: "special_request", text: "a high chair for the baby", from: familyFrom(5) },
      ],
    });
    const changes = fetchChangesOf({ fill: {}, review }, formOf({ specialRequests: held }));
    const requests = changes.filter((c) => c.field === "specialRequests");
    assert.deepEqual(requests.map((c) => c.line), ["Allergy: one of the kids is lactose intolerant", "a high chair for the baby"], "the held allergy is not offered again; the lactose line once");
    assert.equal(requests[0]!.value, `${held}\nAllergy: one of the kids is lactose intolerant`, "each offered under what the form holds");
    assert.notEqual(changeKey(requests[0]!), changeKey(requests[1]!), "each line its own row");
    // Accepted alone, a new line is added on its own; accepted together, both.
    assert.deepEqual(applyFetchChanges([requests[1]!]), { specialRequests: `${held}\na high chair for the baby` });
    assert.deepEqual(applyFetchChanges(requests), { specialRequests: `${held}\nAllergy: one of the kids is lactose intolerant\na high chair for the baby` });
    // Declined, a line is held back on this chat; the other is still offered.
    const declined = rememberDeclined(NO_DECLINED, "mark-5", [requests[0]!], [requests[1]!]);
    assert.deepEqual(offeredChanges(requests, declined, "mark-5").offered.map((c) => c.line), ["a high chair for the baby"]);
    // Case, punctuation and a lead-in aside; the words in their order.
    assert.equal(saysAlready("allergy - SHE IS ALLERGIC TO PEANUTS!", "Allergy: Important: she is allergic to peanuts"), true);
    assert.equal(saysAlready("Allergy: ลูกแพ้ถั่วลิสง", "Allergy: ลูกแพ้ถั่วลิสง"), true, "a Thai line with its marks");
    assert.equal(saysAlready("she is allergic to peanuts", "she is not allergic to peanuts"), false, "other words are another line");
    assert.equal(saysAlready("peanuts allergic", "allergic to peanuts"), false);
    // A form that already says every line: nothing offered.
    const all = fetchChangesOf({ fill: {}, review }, formOf({ specialRequests: `${held}\nOne of the kids is lactose intolerant.\nA high chair for the baby` }));
    assert.equal(all.filter((c) => c.field === "specialRequests").length, 0);
  });

  // --- 4. The WhatsApp number is not a Special requests line ---------------------------------
  await check("theWhatsAppNumberIsNotARequestLine", () => {
    const husband = "If you can't reach me, please call my husband on 089 870 0417";
    const review = reviewOf(
      { event: { whatsapp: { value: "089 870 0417", from: familyFrom(4) } } },
      { requests: [
        { kind: "special_request", text: husband, from: familyFrom(4, husband) },
        { kind: "special_request", text: "a quiet corner for grandma", from: familyFrom(4) },
      ] },
    );
    // Fetch from chat on a form that holds the number (written +66 here): the line is not offered.
    const changes = fetchChangesOf({ fill: {}, review }, formOf({ whatsappPhoneRaw: "+66 89 870 0417", specialRequests: "Allergy: peanuts" }));
    assert.deepEqual(changes.filter((c) => c.field === "specialRequests").map((c) => c.line), ["a quiet corner for grandma"]);
    assert.equal(changes.find((c) => c.field === "whatsappPhoneRaw"), undefined, "the same number is not offered either");
    // The review: the number is the WhatsApp row's, not a Special requests line.
    const held = { ...NOTHING_HELD, whatsapp: "0898700417" };
    const state = initialReviewState(review, { held, saved: held });
    assert.equal(state.details.specialRequests.value, "a quiet corner for grandma");
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
    assert.ok(!html.includes("call my husband"), "nor its words as a reason");
    // The form holding none: the chat's number is the WhatsApp row, and still no request line.
    const fresh = initialReviewState(review, {});
    assert.equal(fresh.details.whatsapp.value, "089 870 0417");
    assert.equal(fresh.details.specialRequests.value, "a quiet corner for grandma");
    // Another number in a line stays a request.
    assert.equal(namesPhone("call the nanny on 081 234 5678", ["089 870 0417"]), false);
    assert.equal(namesPhone("call me on +66-89-870-0417 please", ["0898700417"]), true);
    assert.equal(namesPhone("table for 12 at 14:30", ["0898700417"]), false, "a count or a time is no phone number");
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
