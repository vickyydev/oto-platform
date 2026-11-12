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
//   5. a till code's names are the party's own set menu's: CF-43 offers Fried
//      rice Veggie, Chicken or Shrimp, never another set menu's "Fried Rice";
//      CF-24 is "Margherita", never also "Margherita Pizza".
//   6. the Timeline holds each moment once: no "party starts" or "party ends"
//      step beside the automatic Guests arrive, no setup task again as a step,
//      and one cake line at the cake's time (SCRUM-941).
//   7. a show that becomes an Entertainment Act is not written into
//      Activities as text too.
//   8. the cake is ticked "In the package" only when the chat or the package
//      says so, never by default.
//   1b. (the lane's reviews) the adults' lines are decided line by line: a
//      mirror on a set menu stays a mirror, an adults' order of a dish the
//      kids' list holds that the chat prices is theirs, and a folded line is
//      said in the review and in the toast.
//   1c. (the lane's reviews, SCRUM-944) a dish the set menu gives is no EXTRA:
//      "with the fries" on a set menu that includes them is that dish (no
//      charge, its note in Special requests), and so is an adults' line of
//      the set menu's dishes; "extra fries, 2 plates" is still an EXTRA.
//   9. SCRUM-927's points: another WhatsApp number is written with its stored
//      international form (whatsapp_phone_e164) by the app's own phone rule;
//      the Kitchen Plan does not say "Selections received" when no parent
//      answered the menu link (the choices are marked as read from the chat);
//      Billing's "Deposit from the family's chat" box agrees with the BEO (the
//      deposit asked, not "No deposit asked yet"); the approval's toast names
//      only the sections that were written; a value taken from a long message
//      quotes the words that matter (the sentence, or the clause, saying it).
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
import { readFileSync } from "node:fs";

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
const { loadBeoCatalogue, resolveCatalogueAnswer, timedElsewhere, namesOnlyShows, detailsFromFill, cakeSaidIncluded, quoteOf, moreAsked, BEO_TILL_MENU_RULES } = await import("../server/lib/beoCatalogueFill");
type TranscriptRef = import("../server/lib/beoCatalogueFill").TranscriptRef;
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, menuLinePriceWords, namesPhone, NOTHING_HELD, undecidedOptions, approvalResultWords, adultsFoldNoticeOf } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { DepositRequestPanel, depositAskedOf, depositAskedWords } = await import("../client/src/components/beo/beo-till-billing");
const { fetchChangesOf, applyFetchChanges, rememberDeclined, offeredChanges, changeKey, saysAlready, NO_DECLINED } = await import("../client/src/lib/beo-fetch-from-chat");
const { emptyBeoAiDetails, foodNamesFor, choicesFromChatOnly, SET_MENU_CHOSEN_FROM_CHAT, adultsLinesRepeatKids, adultsFoldedWords } = await import("../shared/beoAiFill");
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
const CHECKS = 15;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
/** The park's till branch (`branches.core_branch_id`): the till's plan view and the till's menu are keyed by it. */
const coreBranch = randomUUID();
const manager = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID(), otherMenu: randomUUID(), bubble: randomUUID() };
const KEYS = ["extra", "mirror", "priced", "options", "timeline", "show", "cake", "cakeHeld", "phone", "chosen", "toast", "mirrorSet", "ownPriced", "leftOut", "included", "moreFries"] as const;
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

  // --- 1b. Line by line, never by the dish names alone (the lane's reviews) -------------------
  await check("anAdultsLineIsTheirOwnLineByLine", async () => {
    const plainNames = (lines: any[]) => lines.map((l) => [l.itemName, l.quantity, l.source ?? null]);
    // A real mirror on a set menu stays a mirror: the adults' nuggets in the adults' headcount, "the same as the kids".
    const set = await approve(ev.mirrorSet, bodyOf({
      setMenu: { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Margherita"] }] },
      menuLines: [
        { menu: "kids", itemName: "Nuggets", quantity: 14, productCode: null, notes: null },
        { menu: "adults", itemName: "nuggets", quantity: 10, productCode: null, notes: "adults eat the same as the kids" },
      ],
    }));
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const setPlan = await kitchenOf(ev.mirrorSet);
    assert.equal(setPlan.menus.adultsDiffer, false, "the set menu's copies counted with them, as SCRUM-829 has it");
    assert.deepEqual(setPlan.menus.adults, []);
    assert.deepEqual([set.body.written.kitchenLines, set.body.written.adultsLinesFolded], [1, 1]);
    assert.equal(approvalResultWords(set.body).includes(adultsFoldedWords(1)), true, "the toast says the line was folded");
    // The adults' own order of a dish the kids' list holds, priced by the chat: written, never folded.
    const priced = await approve(ev.ownPriced, bodyOf({
      menuLines: [
        { menu: "kids", itemName: "Margherita", quantity: 14, productCode: "CF-24", notes: null },
        { menu: "adults", itemName: "3 more Margherita for the adults at 450", quantity: 3, productCode: "CF-24", notes: null, price: 450 },
      ],
    }));
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    const pricedPlan = await kitchenOf(ev.ownPriced);
    assert.equal(pricedPlan.menus.adultsDiffer, true);
    assert.deepEqual((pricedPlan.menus.adults as any[]).map((l) => [l.itemName, l.quantity, l.price, l.productCode]), [["Margherita", 3, 450, "CF-24"]]);
    assert.deepEqual([priced.body.written.kitchenLines, priced.body.written.adultsLinesFolded], [2, undefined]);
    assert.equal(approvalResultWords(priced.body).includes("only repeat"), false, "nothing folded: nothing said");
    // SCRUM-829's rule kept: an adults' list leaving one of the kids' dishes out is the adults' own.
    const leftOut = await approve(ev.leftOut, bodyOf({
      menuLines: [
        { menu: "kids", itemName: "Margherita", quantity: 14, productCode: null, notes: null },
        { menu: "kids", itemName: "Nuggets", quantity: 14, productCode: null, notes: null },
        { menu: "adults", itemName: "Margherita", quantity: 10, productCode: null, notes: null },
      ],
    }));
    assert.equal(leftOut.status, 200, JSON.stringify(leftOut.body));
    const leftPlan = await kitchenOf(ev.leftOut);
    assert.equal(leftPlan.menus.adultsDiffer, true, "no nuggets for the adults");
    assert.deepEqual(plainNames(leftPlan.menus.adults), [["Margherita", 10, null]]);

    // The rule alone: each line its own, by count, price and words.
    const kids = [{ itemName: "Margherita", quantity: 1, source: "set_menu" }, { itemName: "French fries", quantity: 1, source: "set_menu" }, { itemName: "Margherita", quantity: 2 }];
    assert.equal(adultsLinesRepeatKids(kids, [{ itemName: "Margherita", quantity: 10 }], 10), true, "the adults' headcount");
    assert.equal(adultsLinesRepeatKids(kids, [{ itemName: "Margherita", quantity: 2 }], 10), true, "that kids' line's count");
    assert.equal(adultsLinesRepeatKids(kids, [{ itemName: "Margherita", quantity: 3, said: "3 pizzas for the adults" }], 10), false, "another count: their own");
    assert.equal(adultsLinesRepeatKids(kids, [{ itemName: "Margherita", quantity: 1, said: "one more Margherita for grandpa" }], 10), false, "a word asking for more");
    assert.equal(adultsLinesRepeatKids(kids, [{ itemName: "Margherita", quantity: 10, price: 450 }], 10), false, "a price of its own");
    assert.equal(adultsLinesRepeatKids(kids, [{ itemName: "Margherita", quantity: 10, price: 0 }], 10), true);
    assert.equal(adultsLinesRepeatKids(kids, [{ itemName: "Pasta", quantity: 10 }], 10), false, "a dish of their own");
    assert.equal(adultsLinesRepeatKids(kids, [], 10), false);

    // The review says it before Approve and create, from the same rule; their own order is not said.
    const review = reviewOf({
      setMenu: { templateId: cat.setMenu, from: familyFrom(2), choices: [{ itemId: PIZZA, option: "Margherita", said: "Margherita", from: familyFrom(2) }] },
      menuLines: [
        { menu: "kids", itemName: "Nuggets", quantity: 14, productCode: null, matchedName: null, notInMenu: true, chatPrice: null, from: familyFrom(2) },
        { menu: "adults", itemName: "nuggets", quantity: 10, productCode: null, matchedName: null, notInMenu: true, chatPrice: null, notes: "adults eat the same as the kids", from: familyFrom(2) },
      ],
      event: { numAdults: { value: 10, from: familyFrom(1) } },
    });
    review.catalogue = await loadBeoCatalogue(db, { tenantId: tenant, branchId: park });
    const state = initialReviewState(review, {});
    const keptAll = { ...state, menuLines: state.menuLines.map((l) => ({ ...l, decision: "keep" as const })) };
    assert.equal(adultsFoldNoticeOf(review, keptAll), adultsFoldedWords(1));
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state: keptAll, onChange: () => undefined }));
    assert.equal(html.includes('data-testid="text-ai-review-adults-folded"'), true, "shown in the review");
    const more = { ...keptAll, menuLines: keptAll.menuLines.map((l) => (l.menu === "adults" ? { ...l, itemName: "3 more nuggets for the adults", quantity: 3 } : l)) };
    assert.equal(adultsFoldNoticeOf(review, more), null, "their own order: nothing folded");
    const staffPriced = { ...keptAll, menuLines: keptAll.menuLines.map((l) => (l.menu === "adults" ? { ...l, price: 90, priceFrom: "staff" as const } : l)) };
    assert.equal(adultsFoldNoticeOf(review, staffPriced), null, "a price staff entered: their own");
    const tillPriced = { ...keptAll, menuLines: keptAll.menuLines.map((l) => (l.menu === "adults" ? { ...l, price: 90, priceFrom: "till" as const } : l)) };
    assert.equal(adultsFoldNoticeOf(review, tillPriced), adultsFoldedWords(1), "the till's price a coded line opens with is no price of its own");
  });

  // --- 1c. A dish the set menu gives is no EXTRA (the lane's reviews, SCRUM-944) --------------
  await check("aSetMenuDishIsNoExtraCharge", async () => {
    const base = await loadBeoCatalogue(db, { tenantId: tenant, branchId: park });
    // The till sells the set menu's fries and pizza too: Phase C codes them.
    const catalogue = {
      ...base,
      till: [
        { code: "CF-11", name: "French fries", category: "Sides", station: "kitchen" as const, priceSatang: 12000 },
        { code: "CF-24", name: "Margherita", category: "Pizza", station: "kitchen" as const, priceSatang: 32000 },
      ],
    };
    const refsOf = (...texts: string[]): TranscriptRef[] => texts.map((text, i) => ({ line: i + 1, id: `inc-${i}`, source: "family", at: at(i), ruling: false, text }));
    const read = (texts: string[], menuLines: unknown[], numAdults?: number) =>
      resolveCatalogueAnswer(
        {
          package: { templateId: cat.pkg, line: 1 },
          setMenu: { templateId: cat.setMenu, line: 1, choices: [{ itemId: PIZZA, option: "Margherita", said: "Margherita pizza", line: 1 }] },
          menuLines,
          event: { numChildren: { value: 14, line: 1 }, ...(numAdults ? { numAdults: { value: numAdults, line: 1 } } : {}) },
        },
        catalogue,
        refsOf(...texts),
      );
    // The reviewer's case A: "with the fries" on a set menu that always includes them.
    const withFries = read(["The birthday package with Margherita pizza, and with the fries please, no salt on them."], [
      { productCode: "CF-11", itemName: "the fries", menu: "kids", quantity: 1, notes: "no salt", line: 1 },
    ]);
    assert.deepEqual(withFries.menuLines, [], "the set menu's fries, not a second line");
    assert.deepEqual(withFries.details.requests.map((r) => [r.kind, r.text]), [["special_request", "French fries: no salt"]], "its note kept, with the dish's name");
    // More of it is an EXTRA of its own, at the till's price.
    const more = read(["The birthday package with Margherita pizza, and extra fries, 2 plates."], [
      { productCode: "CF-11", itemName: "extra fries", menu: "kids", quantity: 2, line: 1 },
    ]);
    assert.deepEqual(more.menuLines.map((l) => [l.menu, l.productCode, l.quantity]), [["kids", "CF-11", 2]]);
    const onePlate = read(["Margherita pizza for the kids, and one more plate of fries please."], [
      { productCode: "CF-11", itemName: "fries", menu: "kids", quantity: 1, line: 1 },
    ]);
    assert.equal(onePlate.menuLines.length, 1, "one more plate, said beside the dish: an EXTRA");
    // The adults' lines of the set menu's dishes, in the adults' count: their copies of the set menu.
    const adults = read(["Margherita pizza for the kids. 10 adults, they have the same pizza and fries.", "And 3 more Margherita pizzas for the adults."], [
      { productCode: "CF-24", itemName: "pizza", menu: "adults", quantity: 10, line: 1 },
      { productCode: "CF-11", itemName: "fries", menu: "adults", quantity: 10, line: 1 },
      { productCode: "CF-24", itemName: "3 more Margherita pizzas for the adults", menu: "adults", quantity: 3, line: 2 },
    ], 10);
    assert.deepEqual(adults.menuLines.map((l) => [l.menu, l.itemName, l.quantity]), [["adults", "3 more Margherita pizzas for the adults", 3]], "only the adults' own order stays");
    // A line whose words are not held stays a line, as before.
    const unread = resolveCatalogueAnswer(
      { setMenu: { templateId: cat.setMenu, line: 1, choices: [] }, menuLines: [{ productCode: "CF-11", itemName: "fries", menu: "kids", quantity: 1, line: 7 }] },
      catalogue,
      refsOf("A party please."),
    );
    assert.equal(unread.menuLines.length, 1);
    assert.equal(moreAsked("картошка фри", "Пицца Маргарита, дополнительно картошка фри."), true, "in Russian");
    assert.equal(moreAsked("เฟรนช์ฟรายส์", "พิซซ่ามาร์การิต้า เพิ่มเฟรนช์ฟรายส์ บับเบิ้ลโชว์"), true, "in Thai");
    assert.equal(moreAsked("the fries", "2 more Margherita pizzas, and the fries"), false, "another dish's word, in another clause");
    assert.equal(BEO_TILL_MENU_RULES.includes("beyond what the set menu gives"), true);
    assert.equal(BEO_TILL_MENU_RULES.includes("only when the conversation asks for more of it"), true);

    // Approved: the set menu's fries are written once, as the set menu's, with nothing charged.
    const review = reviewOf(withFries);
    review.catalogue = catalogue;
    const state = initialReviewState(review, {});
    assert.equal(state.menuLines.length, 0, "the review offers no fries line to charge");
    const ok = await approve(ev.included, approveBodyOf(review, state, { conversationId: null, messageId: null }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const lines = await viewLinesOf(ev.included);
    assert.equal(lines.filter((l) => l.source === "extra").length, 0, `no EXTRA, no charge: ${JSON.stringify(lines)}`);
    assert.equal(lines.filter((l) => l.name === "French fries").length, 1, "the fries once, the set menu's");
    // "Extra fries, 2 plates": an EXTRA at the till's price, charged.
    const moreReview = reviewOf(more);
    moreReview.catalogue = catalogue;
    const moreState = initialReviewState(moreReview, {});
    assert.deepEqual([moreState.menuLines[0]?.price, moreState.menuLines[0]?.priceFrom], [120, "till"]);
    const extra = await approve(ev.moreFries, approveBodyOf(moreReview, moreState, { conversationId: null, messageId: null }));
    assert.equal(extra.status, 200, JSON.stringify(extra.body));
    const extraLines = (await viewLinesOf(ev.moreFries)).filter((l) => l.source === "extra");
    assert.deepEqual(extraLines.map((l) => [l.name, l.qty, l.unit_price_satang]), [["French fries", 2, 12000]], JSON.stringify(extraLines));
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

  // --- 5. The options of a shared code are the party's own set menu's --------------------------
  await check("aCodesOptionsAreThePartysOwnSetMenus", async () => {
    chats.set("options", [
      { id: `${conv.options}-1`, author: "customer", at: at(0), text: "The Floresta birthday package for 14 kids and 10 adults. OPTIONS-946" },
      { id: `${conv.options}-2`, author: "customer", at: at(1), text: "Fried rice for the adults, and 2 more Margherita pizzas for the kids. OPTIONS-946" },
    ]);
    answers.set("OPTIONS-946", {
      catalogue: {
        package: { templateId: cat.pkg, said: "The Floresta birthday package", line: 1 },
        menuLines: [
          { productCode: "CF-43", itemName: "Fried rice for the adults", menu: "adults", quantity: 1, line: 2 },
          { productCode: "CF-24", itemName: "2 more Margherita pizzas", menu: "kids", quantity: 2, line: 2 },
        ],
      },
    });
    const res = await fill(ev.options);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.equal(review.proposal.setMenu?.templateId, cat.setMenu, "the package's own set menu");
    // The park group's other set menu names both codes too; the party's names them otherwise.
    assert.deepEqual(review.catalogue.food.find((f) => f.code === "CF-43")?.names, ["Fried rice (Veggie)", "Fried rice (Chicken)", "Fried rice (Shrimp)", "Fried Rice"]);
    const [rice, pizza] = review.proposal.menuLines;
    assert.deepEqual([rice?.productCode, rice?.matchedName], ["CF-43", null], "no option named: staff choose");
    assert.deepEqual([pizza?.productCode, pizza?.matchedName], ["CF-24", "Margherita"], "the party's Margherita, not Margherita Pizza");
    const state = initialReviewState(review, { fill: res.body.fill });
    assert.deepEqual(state.menuLines[0]?.options, ["Fried rice (Veggie)", "Fried rice (Chicken)", "Fried rice (Shrimp)"], "only the party's set menu's options");
    assert.equal(state.menuLines[1]?.options, undefined, "one name: nothing to choose");
    assert.equal(undecidedOptions(state), 1);
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
    assert.ok(!html.includes(">Fried Rice<") && !html.includes("Margherita Pizza"), "another set menu's names are not offered");
    const chosen = { ...state, menuLines: state.menuLines.map((l, i) => (i === 0 ? { ...l, matchedName: "Fried rice (Chicken)", changed: true } : l)) };
    const ok = await approve(ev.options, approveBodyOf(review, chosen, { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const plan = await kitchenOf(ev.options);
    const lines = [...(plan.menus.kids as any[]), ...(plan.menus.adults as any[])].filter((l) => l.source === "additional").map((l) => [l.itemName, l.quantity]);
    assert.deepEqual(lines, [["Margherita", 2], ["Fried rice (Chicken)", 1]], "written by the party's own names");
    // A party on the other set menu reads the code by that menu's names; with no set menu, every name.
    assert.deepEqual(foodNamesFor(review.catalogue, "CF-43", cat.otherMenu), ["Fried Rice"]);
    assert.deepEqual(foodNamesFor(review.catalogue, "cf-24", null), ["Margherita", "Margherita Pizza"]);
  });

  // --- 6. The Timeline: each moment once ------------------------------------------------------
  await check("theTimelineHoldsEachMomentOnce", async () => {
    const texts = [
      "Saturday 5 December, from 15:00 to 17:30, 12 kids and 8 adults. TIMELINE-946",
      "2 of the park's cakes at 16:00 please. TIMELINE-946",
      "For the setup, balloons at the entrance by 14:30 please. Games at 16:30, and welcome drinks at 15:00. TIMELINE-946",
    ];
    chats.set("timeline", texts.map((text, i) => ({ id: `${conv.timeline}-${i}`, author: "customer" as const, at: at(i), text })));
    // The proof's thread A answer: the start and the end as steps, the cake as a step beside the
    // cake's time, the setup task as a step beside the setup plan.
    answers.set("TIMELINE-946", {
      catalogue: {
        event: { startTime: { value: "15:00", line: 1 }, endTime: { value: "17:30", line: 1 } },
        cake: { mode: "INTERNAL", notes: "2 of the park's cakes", time: "16:00", line: 2 },
        setup: { readyBy: { value: "14:30", said: "by 14:30", line: 3 }, tasks: [{ label: "balloons at the entrance", notes: "by 14:30", line: 3 }] },
        timeline: [
          { time: "15:00", label: "party starts", line: 1 },
          { time: "15:00", label: "from 15:00", line: 1 },
          { time: "16:00", label: "cakes", line: 2 },
          { time: "17:30", label: "party ends", line: 1 },
          { time: "14:30", label: "balloons at the entrance by 14:30", line: 3 },
          { time: "16:30", label: "Games", line: 3 },
          { time: "15:00", label: "welcome drinks", line: 3 },
        ],
      },
    });
    const res = await fill(ev.timeline);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(review.proposal.details.timeline.map((t) => [t.time, t.label]), [["15:00", "welcome drinks"], ["16:30", "Games"]], "only the chat's own moments");
    const ok = await approve(ev.timeline, approveBodyOf(review, initialReviewState(review, { fill: res.body.fill }), { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const steps = await q<{ label: string; is_system_generated: boolean }>("select label, is_system_generated from beo_timeline_items where event_id = $1", [ev.timeline]);
    const labels = steps.map((t) => t.label);
    assert.equal(labels.filter((l) => /cake/i.test(l)).length, 1, `one cake line: ${JSON.stringify(labels)}`);
    assert.equal(labels.filter((l) => /arrive|starts|from 15/i.test(l)).length, 1, `the start once (Guests arrive): ${JSON.stringify(labels)}`);
    assert.equal(labels.filter((l) => /ends/i.test(l)).length, 0, "no party-ends step");
    assert.equal(labels.filter((l) => /balloons/i.test(l)).length, 1, `the setup task once: ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("Games") && labels.includes("welcome drinks"), "the chat's own steps stay");

    // The rule alone (SCRUM-941): a cake step only when no cake time carries it; another time is still the cake.
    const proposal = { entertainment: [], event: { startTime: { value: "17:00", from: familyFrom(1) }, endTime: { value: "19:30", from: familyFrom(1) } } };
    const cakeAt = (time: string | null, mode: "INTERNAL" | "EXTERNAL" | "NONE" | null = "EXTERNAL") => ({ ...proposal, cake: { mode, notes: null, time, from: familyFrom(3) } });
    assert.equal(timedElsewhere({ time: "17:00", label: "Торт мы принесём свой, в 17:00" }, cakeAt("17:00")), true, "the family's own cake, in Russian");
    assert.equal(timedElsewhere({ time: "18:00", label: "Cake" }, cakeAt("17:00")), true, "the cake is the cake's time's line");
    assert.equal(timedElsewhere({ time: "18:00", label: "Cake" }, cakeAt(null)), false, "no cake time: the step is the one cake line");
    assert.equal(timedElsewhere({ time: "18:00", label: "Cake" }, cakeAt("17:00", "NONE")), false);
    assert.equal(timedElsewhere({ time: "17:00", label: "เริ่มงาน" }, proposal), true, "the start in Thai");
    assert.equal(timedElsewhere({ time: "17:00", label: "Welcome speech" }, proposal), false, "another moment at the start stays");
    assert.equal(timedElsewhere({ time: "18:00", label: "party starts" }, proposal), false, "not at the start: kept");
    assert.equal(timedElsewhere({ time: "19:30", label: "Goodbye and party bags" }, proposal), false, "an end step with its own words stays");
    // The resolver on its own: the same steps of the proof dropped, the chat's own kept.
    const refs: TranscriptRef[] = texts.map((text, i) => ({ line: i + 1, id: `t${i}`, source: "family", at: at(i), ruling: false, text }));
    const read = resolveCatalogueAnswer(answers.get("TIMELINE-946") ? (answers.get("TIMELINE-946") as any).catalogue : {}, review.catalogue, refs);
    assert.deepEqual(read.details.timeline.map((t) => t.label), ["welcome drinks", "Games"]);
  });

  // --- 7. A show is an Entertainment Act, not Activities' text too ----------------------------
  await check("aShowIsItsActNotActivitiesText", async () => {
    chats.set("show", [
      { id: `${conv.show}-1`, author: "customer", at: at(0), text: "A party for ZZ Test Toby, 15:00 to 17:30. SHOW-946" },
      { id: `${conv.show}-2`, author: "staff", at: at(1), text: "Noted: the Bubble show at 16:00, and a treasure hunt for the kids. SHOW-946" },
    ]);
    answers.set("SHOW-946", {
      catalogue: {
        entertainment: [{ templateId: cat.bubble, said: "the Bubble show", quantity: 1, time: "16:00", line: 2 }],
        requests: [
          { kind: "activity", text: "Bubble show at 16:00", line: 2 },
          { kind: "activity", text: "a treasure hunt for the kids", line: 2 },
        ],
      },
    });
    const res = await fill(ev.show);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(review.proposal.details.requests.map((r) => [r.kind, r.text]), [["activity", "a treasure hunt for the kids"]], "the show is not an activity too");
    const ok = await approve(ev.show, approveBodyOf(review, initialReviewState(review, { fill: res.body.fill }), { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [event] = await q("select activities from core_events where id = $1", [ev.show]);
    assert.equal(event!.activities, "a treasure hunt for the kids");
    const acts = await q("select custom_name, start_time from beo_entertainment_items where event_id = $1", [ev.show]);
    assert.deepEqual(acts.map((a) => [a.custom_name, a.start_time]), [["Bubble show", "16:00"]], "the show is its act");
    // The ruling message's own read is held to the same rule.
    const details = detailsFromFill(review.proposal, { event: { activities: "Bubble show at 16:00" } } as any, { existingData: {}, from: { source: "team", at: null, line: null }, event: null });
    assert.equal(details.requests.some((r) => r.text === "Bubble show at 16:00"), false);
    const shows = review.proposal.entertainment;
    assert.equal(namesOnlyShows("The bubble show, at 4 pm", shows), true);
    assert.equal(namesOnlyShows("Bubble show and face painting", shows), false, "words of its own: kept");
    assert.equal(namesOnlyShows("games", shows), false, "no show named: kept");
  });

  // --- 8. "In the package" only when the chat or the package says so --------------------------
  await check("theCakeIsInThePackageOnlyWhenSaid", async () => {
    const confirmed =
      "Confirmed: ZZ Test Toby's 9th birthday party on Saturday 19 December 2026, 13:00 to 15:30, 15 kids and 6 adults, Birthday package, Central Floresta, Pepperoni pizza, the Bubble show at 14:00, drinks from 13:15, the park's cake at 15:00, booking name ZZ TEST Toby, in the Party Room. Deposit 3,000 THB asked.";
    const refsOf = (text: string): TranscriptRef[] => [{ line: 1, id: "c1", source: "team", at: at(0), ruling: true, text }];
    const catalogue = await loadBeoCatalogue(db, { tenantId: tenant, branchId: park });
    const read = (text: string, cake: Record<string, unknown>, pkg?: string) =>
      resolveCatalogueAnswer({ ...(pkg ? { package: { templateId: pkg, line: 1 } } : {}), cake: { line: 1, ...cake } }, catalogue, refsOf(text)).cake;
    // The proof's thread E: the model said included; the line names the package far from the cake.
    assert.equal(read(confirmed, { mode: "INTERNAL", notes: "the park's cake", time: "15:00", included: true })?.included, undefined, "not ticked by default");
    assert.equal(read("Our cake at 16:00, it is included in the package.", { mode: "INTERNAL", time: "16:00", included: true })?.included, true, "the chat says so");
    assert.equal(read("2 cakes, free with the package", { mode: "INTERNAL", included: true })?.included, true);
    assert.equal(read("2 of the park's cakes at 800 baht each", { mode: "INTERNAL", included: false, price: 800 })?.included, false, "charged on its own: EXTRA");
    assert.equal(cakeSaidIncluded(confirmed), false);
    assert.equal(cakeSaidIncluded("เค้กรวมในแพ็กเกจค่ะ"), true, "in Thai");
    // The package says so: a package whose included lines hold a cake.
    const withCake = randomUUID();
    await q(
      `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours, price_weekday, price_weekend, branch_id, sort_order)
       values ($1, $2, 'Cake package 946', 1000000, 10, 4, -1, 3, 1000000, 1200000, $3, 2)`,
      [withCake, tenant, park],
    );
    await q(
      `insert into package_line_item_templates (id, package_template_id, label, category, included, qty_default, default_unit_price, sort_order)
       values ($1, $2, 'Birthday cake (1 kg)', 'food', true, 1, 0, 1)`,
      [randomUUID(), withCake],
    );
    const withPackage = await loadBeoCatalogue(db, { tenantId: tenant, branchId: park });
    const byPackage = resolveCatalogueAnswer({ package: { templateId: withCake, line: 1 }, cake: { mode: "INTERNAL", time: "15:00", line: 1 } }, withPackage, refsOf("The cake package, our cake at 15:00 please."));
    assert.equal(byPackage.cake?.included, true, "the package includes a cake");
    const theirOwn = resolveCatalogueAnswer({ package: { templateId: withCake, line: 1 }, cake: { mode: "EXTERNAL", time: "15:00", line: 1 } }, withPackage, refsOf("The cake package; we bring our own cake."));
    assert.equal(theirOwn.cake?.included, undefined, "the family's own cake is not the package's");

    // Approve and create: a cake with nothing said is written unticked, not on the form's INCL default.
    const body = bodyOf({ cake: { mode: "INTERNAL", notes: "the park's cake", time: "15:00" } });
    const ok = await approve(ev.cake, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await kitchenOf(ev.cake)).menus.cakeIncluded, false);
    const ticked = await approve(ev.cake, bodyOf({ cake: { mode: "INTERNAL", notes: "the park's cake", time: "15:00", included: true } }));
    assert.equal(ticked.status, 200);
    assert.equal((await kitchenOf(ev.cake)).menus.cakeIncluded, true, "ticked in the review: ticked");
    // Staff's own tick on a plan is kept by an approval that says nothing of it.
    await q("insert into beo_kitchen_plans (event_id, menus, cake_mode) values ($1, $2, 'INTERNAL')", [ev.cakeHeld, JSON.stringify({ kids: [], adults: [], cakeIncluded: true })]);
    const held = await approve(ev.cakeHeld, body);
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.equal((await kitchenOf(ev.cakeHeld)).menus.cakeIncluded, true);
  });

  // --- 9a. The WhatsApp number's stored international form -----------------------------------
  await check("anotherWhatsAppNumberIsStoredInItsInternationalForm", async () => {
    const phoneRow = async () => (await q("select whatsapp_phone_raw, whatsapp_phone_e164, whatsapp_parse_valid, whatsapp_parse_error from core_events where id = $1", [ev.phone]))[0]!;
    await q("update core_events set whatsapp_phone_raw = '+66811111111', whatsapp_phone_e164 = '+66811111111' where id = $1", [ev.phone]);
    let res = await approve(ev.phone, bodyOf({ event: { whatsappPhoneRaw: "089 870 0417" } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let row = await phoneRow();
    assert.deepEqual([row.whatsapp_phone_raw, row.whatsapp_phone_e164, row.whatsapp_parse_valid, row.whatsapp_parse_error], ["089 870 0417", "+66898700417", true, null], "the new number, both forms");
    res = await approve(ev.phone, bodyOf({ event: { whatsappPhoneRaw: "+44 20 7946 0958" } }));
    row = await phoneRow();
    assert.equal(row.whatsapp_phone_e164, "+442079460958", "an international number as written");
    res = await approve(ev.phone, bodyOf({ event: { whatsappPhoneRaw: "1234" } }));
    assert.equal(res.status, 200);
    row = await phoneRow();
    assert.deepEqual([row.whatsapp_phone_raw, row.whatsapp_phone_e164, row.whatsapp_parse_valid], ["1234", null, false], "a number the rule cannot read: kept raw, said so, never the old number's link");
    assert.ok(typeof row.whatsapp_parse_error === "string" && row.whatsapp_parse_error.length > 0);
    // An approval that sends no number leaves both as they are.
    await approve(ev.phone, bodyOf({ event: { numChildren: 12 } }));
    assert.equal((await phoneRow()).whatsapp_phone_raw, "1234");
  });

  // --- 9b. "Selections received" only when a parent answered --------------------------------
  await check("choicesFromTheChatAreNotSelectionsReceived", async () => {
    const selectionOf = async () => (await q("select is_submitted, selections from beo_set_menu_selections where event_id = $1", [ev.chosen]))[0]!;
    const res = await approve(ev.chosen, bodyOf({ setMenu: { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Hawaiian"] }] } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let sel = await selectionOf();
    assert.equal(sel.is_submitted, true, "recorded, so the link keeps the family's and the kitchen's choice in step as before");
    assert.deepEqual(sel.selections, [{ groupId: PIZZA, chosenOptions: ["Hawaiian"], recordedFrom: "chat" }]);
    assert.equal(choicesFromChatOnly(sel.selections), true, "no parent answered: not 'Selections received'");
    // A choice a parent sent is kept unmarked beside an approval's own; then a parent did answer.
    await q("update beo_set_menu_selections set selections = $2 where event_id = $1", [ev.chosen, JSON.stringify([{ groupId: RICE, chosenOptions: ["Chicken"] }])]);
    await approve(ev.chosen, bodyOf({ setMenu: { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Margherita"] }] } }));
    sel = await selectionOf();
    assert.deepEqual(sel.selections, [{ groupId: RICE, chosenOptions: ["Chicken"] }, { groupId: PIZZA, chosenOptions: ["Margherita"], recordedFrom: "chat" }]);
    assert.equal(choicesFromChatOnly(sel.selections), false, "a parent's choice in it: 'Selections received'");
    assert.equal(choicesFromChatOnly([]), false);
    assert.equal(choicesFromChatOnly(null), false);
    // The Kitchen Plan's badge, its date line and the parent link's dialog read the mark.
    const editor = readFileSync(new URL("../client/src/components/beo/beo-event-editor.tsx", import.meta.url), "utf8");
    assert.equal(editor.split("choicesFromChatOnly(setMenuSelection.selections)").length - 1, 4, "the badge, the date line and the dialog's two lines");
    assert.ok(editor.includes("{choicesFromChatOnly(setMenuSelection.selections) ? SET_MENU_CHOSEN_FROM_CHAT : \"Selections received\"}"));
    assert.equal(SET_MENU_CHOSEN_FROM_CHAT, "Chosen from the chat");
  });

  // --- 9c. Billing's deposit box agrees with the BEO ------------------------------------------
  await check("theDepositBoxSaysTheDepositTheBeoAsks", async () => {
    // The proof's thread E: the team asked 3,000 in the chat; the approval wrote it as asked.
    const res = await approve(ev.chosen, bodyOf({ deposit: { amount: 3000, paid: false, date: null } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [billing] = await q("select deposit_required, deposit_amount, deposit_paid from beo_event_billing where event_id = $1", [ev.chosen]);
    const asked = depositAskedOf({ depositRequired: billing!.deposit_required, depositAmount: billing!.deposit_amount, depositPaid: billing!.deposit_paid });
    assert.equal(asked, 3000);
    const reading = { status: "ok", answer: { eventId: ev.chosen, hasConversation: true, current: null, history: [] }, readAt: at(5) } as any;
    const html = renderToStaticMarkup(React.createElement(DepositRequestPanel, { eventId: ev.chosen, reading, isManager: true, asked }));
    assert.ok(html.includes("The BEO asks a ฿3,000 deposit. No payment link has been sent yet"), "the BEO's deposit, not 'No deposit asked yet'");
    assert.ok(!html.includes("No deposit asked yet"));
    assert.ok(html.includes('value="3000"'), "the amount to ask is the BEO's");
    assert.equal(depositAskedWords(3000).startsWith("The BEO asks a ฿3,000 deposit."), true);
    // With nothing asked (or the deposit received), the box says so as before.
    const none = renderToStaticMarkup(React.createElement(DepositRequestPanel, { eventId: ev.chosen, reading, isManager: true }));
    assert.ok(none.includes("No deposit asked yet."));
    assert.equal(depositAskedOf({ depositRequired: true, depositAmount: 3000, depositPaid: true }), null, "received: nothing asked");
    assert.equal(depositAskedOf({ depositRequired: false, depositAmount: 3000, depositPaid: false }), null);
    assert.equal(depositAskedOf(null), null);
    // The billing section hands the box the BEO's billing.
    const billingFile = readFileSync(new URL("../client/src/components/beo/beo-till-billing.tsx", import.meta.url), "utf8");
    assert.ok(billingFile.includes("asked={depositAskedOf(billing)}"));
  });

  // --- 9d. The toast names only what was written ----------------------------------------------
  await check("theToastNamesOnlyWhatWasWritten", async () => {
    // The proof's thread D: no setup, no POS box, no team, no deposit, no bar, no entertainment.
    let res = await approve(ev.toast, bodyOf({
      event: { numChildren: 14 },
      package: { templateId: cat.pkg, addOns: [] },
      setMenu: { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Margherita"] }] },
      cake: { mode: "EXTERNAL", notes: "their own cake", time: "17:00" },
      details: { timeline: [{ time: "16:00", label: "Games" }] },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      approvalResultWords(res.body),
      "Saved: the event's details (name, counts, times), the package, the kitchen plan and the timeline's steps.",
    );
    res = await approve(ev.toast, bodyOf({ cake: { mode: "EXTERNAL", notes: "their own cake", time: "17:00" } }));
    assert.equal(approvalResultWords(res.body), "Saved: the kitchen plan.");
    res = await approve(ev.toast, bodyOf({ deposit: { amount: 3000, paid: false, date: null }, details: { setupReadyBy: "14:30" } }));
    assert.equal(approvalResultWords(res.body), "Saved: the setup plan and the deposit.");
    // A server before this rule answers no count: the fixed words, as before.
    assert.ok(approvalResultWords({}).startsWith("Saved: the event's name and details, the counts"));
  });

  // --- 9e. The words that matter in a long message -------------------------------------------
  await check("aLongMessageIsQuotedByTheWordsThatMatter", () => {
    // The proof's thread A, line 4, and its thread E's confirmation (the numbers as written there).
    const family = "Important: she is allergic to peanuts. For the setup, balloons at the entrance by 13:30 please. If you can't reach me, please call my husband on 089 870 0417 (invented). We will transfer the 3,000 baht deposit tomorrow. (ZZ TEST)";
    assert.equal(quoteOf(null, family, [3000]), "We will transfer the 3,000 baht deposit tomorrow.", "the deposit's own sentence");
    assert.equal(quoteOf(null, family, ["13:30"]), "For the setup, balloons at the entrance by 13:30 please.");
    const first = "Hi! We'd like to book a birthday party for our daughter ZZ Test Lina, she turns 6. Saturday 5 December, from 14:00 to 16:30, 12 kids and 8 adults. (ZZ TEST)";
    assert.equal(quoteOf(null, first, ["14:00"]), "Saturday 5 December, from 14:00 to 16:30, 12 kids and 8 adults.");
    const confirmed =
      "Confirmed: ZZ Test Toby's 9th birthday party on Saturday 19 December 2026, 13:00 to 15:30, 15 kids and 6 adults, Birthday package, Central Floresta, Pepperoni pizza, the Bubble show at 14:00, drinks from 13:15, the park's cake at 15:00, booking name ZZ TEST Toby, in the Party Room. Deposit 3,000 THB asked.";
    assert.equal(quoteOf(null, confirmed, ["6 adult", 6]), "15 kids and 6 adults", "a sentence too long to quote: its clause");
    assert.equal(quoteOf(null, confirmed, ["Party Room"]), "in the Party Room.");
    assert.equal(quoteOf(null, confirmed, [3000]), "Deposit 3,000 THB asked.");
    assert.equal(quoteOf(null, confirmed, ["15:00"]), "the park's cake at 15:00");
    // As before: the model's own words when the line holds them; a short line whole; nothing found, the line's start.
    assert.equal(quoteOf("the Bubble show", confirmed, ["14:00"]), "the Bubble show");
    assert.equal(quoteOf(null, "12 kids and 8 adults, 14:00. (ZZ TEST)", [12]), "12 kids and 8 adults, 14:00. (ZZ TEST)");
    assert.ok(quoteOf(null, confirmed, ["nothing here"])!.startsWith("Confirmed:"));
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_timeline_items where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from beo_set_menu_selections where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from package_line_item_templates where package_template_id in (select id from birthday_package_templates where tenant_id = $1)", [tenant]).catch(() => undefined);
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
