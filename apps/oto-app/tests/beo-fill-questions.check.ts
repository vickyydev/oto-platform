// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub inbox, a stub till menu) and needs a
// database whose otoapp schema the app's migrator has built. It renders the
// review's own component, so it runs with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// The BEO's AI Fill after the owner's answers of 19 November:
//   - SCRUM-1035: a question the team asked and the family never answered
//     ("Would you like the bubble show at 15:00?") is never written as agreed,
//     on any field. The rule is in what the model reads (both reads, under a
//     park group's saved advice too) and in the code that accepts a proposal:
//     each field kind proposed from such a question is left out, before the
//     review, the team's names and the approval; a family's answer after it,
//     a team's statement, and what the family itself asked stay as before; the
//     deposit keeps its own rule; the activity row counts what was left out;
//     the ruling message's own read (Load into Editor, Fetch from chat) too.
//   - SCRUM-1030: AI Fill proposes the Kitchen Notes from what the family says
//     of handling or serving the food; the review shows it with the chat's
//     words beside what the form holds; Approve and create writes it to the
//     kitchen plan, and only then.
//   - SCRUM-1050: AI Fill no longer proposes a typed timeline row for a step
//     the Timeline makes itself (setup ready, guests arrive, a food service,
//     the cake, a show of the entertainment); a moment of its own (a piñata)
//     stays an "Other timed step".
//
// Every model answer here is scripted: no model key is used, nothing is recorded.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-fill-questions.check.ts
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
  console.error("beo-fill-questions.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1035";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const {
  loadBeoCatalogue, resolveCatalogueAnswer, withoutUnansweredQuestions, unansweredQuestion, saidAsQuestion, timedElsewhere, detailsFromFill, fillWithoutUnansweredQuestions,
  beoCatalogueSystemBlock, BEO_CONVERSATION_OUTPUT_FORMAT, CONVERSATION_SHAPE,
} = await import("../server/lib/beoCatalogueFill");
type TranscriptRef = import("../server/lib/beoCatalogueFill").TranscriptRef;
const { BEO_QUESTION_NOT_AGREED, BUILT_IN_BEO_PARSING_ADVICE, requiredFieldsBlock } = await import("../server/lib/aiFill");
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, approvalResultWords, APPROVED_SECTIONS } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { emptyBeoAiDetails } = await import("../shared/beoAiFill");
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
type BeoAiProposal = import("../shared/beoAiFill").BeoAiProposal;
type BeoAiCatalogueView = import("../shared/beoAiFill").BeoAiCatalogueView;
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;

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
const CHECKS = 16;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const manager = randomUUID();
const nok = randomUUID();
const cat = { pkg: randomUUID(), setMenu: randomUUID(), bubble: randomUUID(), table: randomUUID(), kidsTable: randomUUID() };
const KEYS = ["open", "answered", "ruled", "pasted", "notes", "held"] as const;
type Key = (typeof KEYS)[number];
const ev = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const conv = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const PIZZA = "item_1035_pizza";
const BOOKED = "2099-12-05";
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" } },
];

// The conversation: the family asks; the team answers with questions the family never answers.
const FAMILY_ASKS =
  "Hi! A birthday party for ZZ Test Lina turning 6 on Saturday 5 December, 14:00 to 16:30, 12 kids and 8 adults. The Floresta birthday package please, Margherita pizza for the kids. Lina is allergic to peanuts, so no peanuts in anything please. (ZZ TEST)";
const TEAM_ASKS =
  "Thank you, noted! Would you like to add the bubble show at 15:00 for 5,500 baht? Shall we add 2 more Hawaiian pizzas at 450 each? " +
  "Would you like the reserved table for the adults? Would 2 jugs of lemonade suit the kids? Shall we have the cake at 16:00? Should Nok host the party? " +
  "Shall we serve the food at 15:30? Would you like a balloon arch, ready by 13:30? Shall we do a piñata at 15:45? Shall I book you into the Jungle Room? " +
  "Would you like it without chilli for the kids? Shall we add a candy bar to the bill? (ZZ TEST)";
const FAMILY_YES = "Yes please, all of that sounds perfect! (ZZ TEST)";
const at = (i: number) => new Date(Date.UTC(2026, 10, 19, 9, i)).toISOString();
const family = (line: number) => ({ source: "family" as const, at: at(line - 1), line });
const team = (line: number) => ({ source: "team" as const, at: at(line - 1), line });
const refsOf = (lines: Array<["family" | "team", string]>): TranscriptRef[] =>
  lines.map(([source, text], i) => ({ line: i + 1, id: `r${i}`, source, at: at(i), ruling: false, text }));

/** The model's answer for that conversation, as a model that ignored the rule would give it: every question written as agreed. */
const answerFor = (asked: number) => ({
  package: { templateId: cat.pkg, said: "The Floresta birthday package please", line: 1 },
  setMenu: { templateId: cat.setMenu, line: 1, choices: [{ itemId: PIZZA, option: "Margherita", said: "Margherita pizza for the kids", line: 1 }] },
  addOns: [
    { lineId: cat.table, said: "the reserved table for the adults", quantity: 1, line: asked },
    { lineId: randomUUID(), said: "a candy bar", quantity: 1, line: asked },
  ],
  menuLines: [
    { productCode: "CF-27", itemName: "2 more Hawaiian pizzas", menu: "kids", quantity: 2, chatPrice: 450, line: asked },
    { productCode: null, notInMenu: true, itemName: "2 jugs of lemonade", menu: "bar", quantity: 2, line: asked },
  ],
  entertainment: [{ templateId: cat.bubble, said: "the bubble show at 15:00", quantity: 1, chatPrice: 5500, time: "15:00", line: asked }],
  event: {
    childName: { value: "ZZ Test Lina", line: 1 },
    numChildren: { value: 12, line: 1 },
    numAdults: { value: 8, line: 1 },
    startTime: { value: "14:00", line: 1 },
    endTime: { value: "16:30", line: 1 },
    kidsFoodTime: { value: "15:30", said: "serve the food at 15:30", line: asked },
    locationText: { value: "Jungle Room", said: "the Jungle Room", line: asked },
  },
  cake: { mode: "INTERNAL", time: "16:00", notes: "the cake at 16:00", line: asked },
  deposit: { amount: 3000, paid: false, line: asked },
  requests: [
    { kind: "allergy", text: "Lina is allergic to peanuts", line: 1 },
    { kind: "decoration", text: "a balloon arch", line: asked },
  ],
  setup: { readyBy: { value: "13:30", said: "ready by 13:30", line: asked }, tasks: [{ label: "a balloon arch", line: asked }] },
  pos: { items: [{ description: "a candy bar", type: "extra", line: asked }] },
  team: { partyHost: { value: "Nok", said: "Should Nok host the party?", line: asked } },
  kitchenNotes: { value: "no peanuts in anything please", said: "no peanuts in anything please", line: 1 },
  timeline: [{ time: "15:45", label: "a piñata", line: asked }],
});

let catalogue: BeoAiCatalogueView;
const modelCalls: AiCompleteOptions[] = [];
/** The scripted answers: by the conversation's own words, the conversation's read; the ruling message's read by its text. */
const formAnswers = new Map<string, unknown>();
const conversationAnswers = new Map<string, unknown>();
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    const answers = call.system.includes("THE CONVERSATION") ? conversationAnswers : formAnswers;
    for (const [mark, answer] of answers) if (call.user.includes(mark)) return JSON.stringify(answer);
    return JSON.stringify({ summary: "ZZ plain" });
  },
};
const inbox = new Map<string, InboxRead>();
const transcriptOf = (key: Key, lines: Array<["customer" | "staff", string]>, ruling: number | null): InboxRead => ({
  ok: true,
  confirmation: {
    conversationId: conv[key],
    eventId: ev[key],
    message: ruling === null ? null : { id: randomUUID(), body: lines[ruling]![1], bodyLanguage: null, authorName: "ZZ TEST team", sentAt: at(ruling), createdAt: at(ruling) },
    scanned: lines.length,
    transcript: lines.map(([author, text], i) => ({ id: randomUUID(), author, at: at(i), text })),
    transcriptCut: false,
  },
});

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  if (req.get("x-test-as") !== "manager") return res.status(401).json({ message: "Not signed in" });
  (req as any).isAuthenticated = () => true;
  (req as any).user = { id: manager, tenantId: tenant, role: "manager" };
  (req as any).userWithAccess = { id: manager, tenantId: tenant, isActive: true, role: "manager", hasAllBranchesAccess: false, allowedBranchIds: [park] };
  next();
}
let savedAdvice: string | null = null;
const servers: Server[] = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
registerAIRoutes(app, fakeAuth, {
  ai,
  readSetting: async (_req, key) => (key === "ai_beo_parsing_advice" ? savedAdvice : null),
  inboxConfirmation: async (_req, conversationId) => inbox.get(conversationId) ?? { ok: false, reason: "inbox_unreachable" },
  catalogue: async (event) => loadBeoCatalogue(db, { tenantId: event.tenantId, branchId: event.branchId }),
  tillMenu: async () => ({ status: "not_linked", message: null, items: [] }),
  paidLines: async () => new Map(),
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
const fill = (key: Key, existingData: unknown = { event: { title: "ZZ TEST" } }) => post(`/api/events/${ev[key]}/beo/ai-fill/inbox`, { existingData });
const approve = (key: Key, body: unknown) => post(`/api/events/${ev[key]}/beo/ai-fill/approve`, body);
const html = (review: BeoAiReview, state: ReturnType<typeof initialReviewState>) =>
  renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
const ids = { conversationId: null, messageId: null };

/** What a proposal still holds of the team's questions, by field kind (empty: none). */
function questionsLeft(p: BeoAiProposal): string[] {
  const left: string[] = [];
  if (p.addOns.length) left.push("addOns");
  if (p.otherLines.some((o) => /candy/i.test(o.text))) left.push("otherLines");
  if (p.menuLines.some((l) => /hawaiian/i.test(l.itemName))) left.push("menuLines");
  if (p.menuLines.some((l) => l.menu === "bar")) left.push("bar");
  if (p.entertainment.length) left.push("entertainment");
  if (p.event.kidsFoodTime) left.push("kidsFoodTime");
  if (p.cake) left.push("cake");
  if (p.details.locationText) left.push("locationText");
  if (p.details.requests.some((r) => r.kind === "decoration")) left.push("requests");
  if (p.details.setup.readyBy) left.push("setup.readyBy");
  if (p.details.setup.tasks.length) left.push("setup.tasks");
  if (p.details.pos.items.length) left.push("pos.items");
  if (p.details.hosts?.partyHost) left.push("hosts");
  if (p.details.timeline.length) left.push("timeline");
  return left;
}
const ALL_ASKED = ["addOns", "otherLines", "menuLines", "bar", "entertainment", "kidsFoodTime", "cake", "locationText", "requests", "setup.readyBy", "setup.tasks", "pos.items", "hosts", "timeline"];

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 1035 ${run}`, `zz-1035-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, 'ZZ TEST Central Floresta 1035', 'ZZ TEST', 'Asia/Bangkok')", [park, tenant]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 1035', 'manager', true, false)", [
    manager, `zz-1035-${manager.slice(0, 8)}@example.com`,
  ]);
  await q(`insert into employees (id, tenant_id, full_name, nickname, email, branch_id, employment_state) values ($1, $2, 'ZZ TEST Siriporn 1035', 'Nok', $3, $4, 'ACTIVE')`, [
    nok, tenant, `zz-1035-${nok.slice(0, 8)}@example.com`, park,
  ]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Birthday set menu 1035', $3)", [cat.setMenu, tenant, JSON.stringify(setMenuItems)]);
  await q(
    `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours,
       price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, set_menu_template_id, branch_id, sort_order)
     values ($1, $2, 'Birthday package 1035', 1690000, 10, 4, -1, 3, 1690000, 2090000, 130000, 150000, $3, $4, 1)`,
    [cat.pkg, tenant, cat.setMenu, park],
  );
  await q(
    `insert into package_line_item_templates (id, package_template_id, category, label, qty_default, qty_editable, included, default_unit_price, billable_by_default, sort_order, fnb_credit, prints_voucher)
     values ($1, $3, 'setup', 'Kids'' table reserved for 3 hours', 1, false, true, 0, false, 0, null, false),
            ($2, $3, 'setup', 'Reserved table for adults', 0, true, false, 500000, true, 1, 500000, true)`,
    [cat.kidsTable, cat.table, cat.pkg],
  );
  await q(
    `insert into entertainment_package_templates (id, tenant_id, name, category, duration_minutes, default_price, billable_by_default, unit, sort_order)
     values ($1, $2, 'Bubble show', 'Shows', 30, 550000, true, 'session', 1)`,
    [cat.bubble, tenant],
  );
  for (const key of KEYS) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, status, inbox_conversation_id, num_children, num_adults)
       values ($1, $2, $3, 'birthday', $4, $5, '14:00', '16:30', 'tentative', $6, 12, 8)`,
      [ev[key], tenant, park, `ZZ TEST 1035 ${key}`, BOOKED, conv[key]],
    );
  }
  catalogue = await loadBeoCatalogue(db, { tenantId: tenant, branchId: park });

  // --- SCRUM-1035: the rule in the words the model reads ----------------------------------------
  await check("theRuleIsInWhatTheModelReads", async () => {
    for (const piece of [
      "A QUESTION IS NOT AN AGREEMENT",
      "Until a line of the family's after it answers it, write nothing of it into any field as if it were agreed",
      "no dish, drink, quantity, price, time, package, add-on, show, activity, setup task, person, timeline step, request or note saying it was agreed",
      "\"Yes please\" to \"Would you like the bubble show at 15:00?\" agrees the bubble show at 15:00",
      "never from the team's question",
      "no show, no 15:00 and no 1,500 anywhere",
      "What the family clearly asked for or agreed is given as always",
    ]) {
      assert.ok(BEO_QUESTION_NOT_AGREED.includes(piece), `the rule says: ${piece}`);
    }
    for (const word of ["THE CONVERSATION", "THE PARK'S CATALOGUE"]) assert.ok(!BEO_QUESTION_NOT_AGREED.includes(word), "never a heading the reads are told apart by");
    // On the route: both reads carry it after the catalogue and before today, under a park group's saved advice too.
    inbox.set(conv.open, transcriptOf("open", [["customer", FAMILY_ASKS], ["staff", TEAM_ASKS]], 1));
    conversationAnswers.set(TEAM_ASKS, { catalogue: answerFor(2) });
    for (const advice of [null, "ZZ TEST PARK ADVICE"]) {
      savedAdvice = advice;
      modelCalls.length = 0;
      const res = await fill("open");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const conversation = modelCalls.find((c) => c.system.includes("THE CONVERSATION"))!;
      const form = modelCalls.find((c) => !c.system.includes("THE CONVERSATION"))!;
      for (const call of [conversation, form]) {
        const rule = call.system.indexOf(BEO_QUESTION_NOT_AGREED);
        assert.ok(rule > 0, `${advice ?? "built-in"}: the rule rides on the read`);
        assert.ok(call.system.lastIndexOf("Today at ") > rule, "today stays last");
        if (advice) assert.ok(call.system.startsWith(advice), "the saved advice stays first");
      }
      assert.ok(conversation.system.indexOf("THE PARK'S CATALOGUE") < conversation.system.indexOf(BEO_QUESTION_NOT_AGREED), "after the catalogue");
    }
    savedAdvice = null;
    // SCRUM-1050 and SCRUM-1030 in the same words: the timeline is the other timed steps; the Kitchen Notes are asked.
    const block = beoCatalogueSystemBlock(catalogue, { conversation: true });
    assert.ok(block.includes("The BEO makes its own timeline step for the setup being ready, the guests arriving, the food and the drinks being served, the cake and each show"));
    assert.ok(block.includes("(a piñata at 13:30, a photo session at 15:00)"));
    assert.ok(!block.includes("(the cake, a show, the food, the end)"), "the old words asking the cake, a show and the food as steps are gone");
    assert.ok(BUILT_IN_BEO_PARSING_ADVICE.includes("Timeline: only a timed moment the form has no time of its own for (a piñata at 13:30)"));
    assert.ok(block.includes("\"kitchenNotes\": what the conversation says the kitchen must know about handling or serving the food"));
    assert.ok(BEO_CONVERSATION_OUTPUT_FORMAT.includes('"kitchenNotes": { "value"'));
    assert.ok(requiredFieldsBlock(CONVERSATION_SHAPE).includes("\n- catalogue.kitchenNotes.value: "), "the fields the app requires name it");
  });

  // --- SCRUM-1035: the code that accepts a proposal ------------------------------------------------
  await check("aLineThatAsksIsToldFromOneThatSays", () => {
    assert.equal(saidAsQuestion("Would you like the bubble show at 15:00?", ["bubble show"]), true);
    assert.equal(saidAsQuestion("Confirmed: the bubble show at 15:00. Would you like extra fries?", ["bubble show"]), false, "a statement beside a question");
    assert.equal(saidAsQuestion("Confirmed: the bubble show at 15:00. Would you like extra fries?", ["extra fries"]), true);
    assert.equal(saidAsQuestion("รับเค้กเพิ่มไหมคะ", ["เค้ก"]), true, "a Thai question with its particle and no mark");
    assert.equal(saidAsQuestion("เค้กช็อกโกแลต 1 ก้อนค่ะ", ["เค้ก"]), false);
    assert.equal(saidAsQuestion("Хотите шоу мыльных пузырей в 15:00?", ["15:00"]), true);
    assert.equal(saidAsQuestion("Party at 14.00 น. for 12 kids. Cake?", ["12 kids"]), false, "a time written 14.00 ends no sentence");
    assert.equal(saidAsQuestion("Shall we? Would you?", ["nothing said"]), true, "words not in the line: asked only when every sentence asks");
    assert.equal(saidAsQuestion("Noted. Would you?", ["nothing said"]), false);
    const refs = refsOf([["family", FAMILY_ASKS], ["team", TEAM_ASKS]]);
    assert.equal(unansweredQuestion(team(2), refs, null, ["2 more Hawaiian pizzas"]), true, "the team asked; the family wrote nothing after");
    assert.equal(unansweredQuestion(team(2), [...refs, ...refsOf([["family", FAMILY_YES]]).map((r) => ({ ...r, line: 3 }))], null, ["2 more Hawaiian pizzas"]), false, "answered by a later line of the family's");
    assert.equal(unansweredQuestion(family(1), refs, null, ["Margherita pizza for the kids"]), false, "the family's own words are never refused");
    assert.equal(unansweredQuestion(team(2), refs, null, ["Thank you, noted"]), false, "a statement of the team's");
    assert.equal(unansweredQuestion({ source: "default", at: null, line: null }, refs, null, ["x"]), false);
    assert.equal(unansweredQuestion({ source: "team", at: null, line: null }, [], TEAM_ASKS, ["the bubble show"]), true, "the ruling message read alone: no line after it is known");
    assert.equal(unansweredQuestion({ source: "team", at: null, line: 9 }, refs, null, ["the bubble show"]), false, "a line not held cannot be told");
  });

  await check("noQuestionNobodyAnsweredIsProposedOnAnyField", () => {
    const refs = refsOf([["family", FAMILY_ASKS], ["team", TEAM_ASKS]]);
    const read = resolveCatalogueAnswer(answerFor(2), catalogue, refs);
    assert.deepEqual(questionsLeft(read), ALL_ASKED, "the read as the model gave it holds every question as agreed");
    assert.ok(read.deposit, "and the deposit asked for");
    const refused = withoutUnansweredQuestions(read, refs);
    assert.deepEqual(questionsLeft(read), [], "none of them is proposed");
    assert.ok(refused >= ALL_ASKED.length, `each left out is counted (${refused})`);
    // What the family asked stays, as the family's.
    assert.equal(read.package?.templateId, cat.pkg);
    assert.deepEqual(read.setMenu?.choices.map((c) => c.option), ["Margherita"]);
    assert.deepEqual([read.event.numChildren?.value, read.event.numAdults?.value, read.event.startTime?.value, read.event.endTime?.value], [12, 8, "14:00", "16:30"]);
    assert.deepEqual(read.details.requests.map((r) => [r.kind, r.text]), [["allergy", "Lina is allergic to peanuts"]]);
    assert.equal(read.details.kitchenNotes?.value, "no peanuts in anything please");
    assert.equal(read.details.kitchenNotes?.from.source, "family");
    // The deposit keeps its own rule, unchanged: a requested amount, never received money.
    assert.deepEqual([read.deposit?.amount, read.deposit?.paid], [3000, false]);

    // Answered by the family after it: every one stays, as before.
    const answeredRefs = refsOf([["family", FAMILY_ASKS], ["team", TEAM_ASKS], ["family", FAMILY_YES]]);
    const answered = resolveCatalogueAnswer(answerFor(2), catalogue, answeredRefs);
    assert.equal(withoutUnansweredQuestions(answered, answeredRefs), 0);
    assert.deepEqual(questionsLeft(answered), ALL_ASKED, "the family said yes: every one stays, as before");
    // The team saying it, not asking: it stays.
    const said = "Confirmed: the bubble show at 15:00 for 5,500 baht, and 2 more Hawaiian pizzas at 450 each. (ZZ TEST)";
    const saidRefs = refsOf([["family", FAMILY_ASKS], ["team", said]]);
    const stated = resolveCatalogueAnswer(answerFor(2), catalogue, saidRefs);
    withoutUnansweredQuestions(stated, saidRefs);
    assert.ok(stated.entertainment.length === 1 && stated.menuLines.some((l) => /hawaiian/i.test(l.itemName)), "a statement of the team's is no question");
    // The ruling message read alone (no conversation): its questions are not agreed either.
    const alone = resolveCatalogueAnswer({ ...answerFor(1), package: undefined, setMenu: undefined }, catalogue, [], { source: "team", at: at(1), line: null }, TEAM_ASKS);
    withoutUnansweredQuestions(alone, [], TEAM_ASKS);
    assert.deepEqual([alone.entertainment.length, alone.menuLines.length, alone.cake, alone.details.timeline.length], [0, 0, null, 0]);
  });

  await check("aQuestionRepeatingTheFamilysRequestChangesNothing", () => {
    const readBack = "So 12 kids and the bubble show, right? (ZZ TEST)";
    const asks = "Hi, 12 kids please, and we'd love the bubble show. (ZZ TEST)";
    const refs = refsOf([["family", asks], ["team", readBack]]);
    // The model gives the family's line for what the family asked (the rule's own words): it stays.
    const fromFamily = resolveCatalogueAnswer(
      { event: { numChildren: { value: 12, line: 1 } }, entertainment: [{ templateId: cat.bubble, said: "the bubble show", line: 1 }] },
      catalogue,
      refs,
    );
    assert.equal(withoutUnansweredQuestions(fromFamily, refs), 0);
    assert.deepEqual([fromFamily.event.numChildren?.value, fromFamily.entertainment.length], [12, 1]);
    // Given from the team's read-back instead (the review): the family's own earlier line says it, so it stays.
    const fromQuestion = resolveCatalogueAnswer({ event: { numChildren: { value: 12, line: 2 } } }, catalogue, refs);
    assert.equal(withoutUnansweredQuestions(fromQuestion, refs), 0);
    assert.equal(fromQuestion.event.numChildren?.value, 12);
    // The review's read-back: "So it's Saturday 21 March at 14:00 for 15 kids, right?" sent last, after the family's own line.
    const backRefs = refsOf([
      ["family", "Hi! A party on Saturday 21 March at 14:00 for 15 kids please. (ZZ TEST)"],
      ["team", "So it's Saturday 21 March at 14:00 for 15 kids, right? (ZZ TEST)"],
    ]);
    const back = resolveCatalogueAnswer({ event: { startTime: { value: "14:00", line: 2 }, numChildren: { value: 15, line: 2 } } }, catalogue, backRefs);
    assert.equal(withoutUnansweredQuestions(back, backRefs), 0);
    assert.deepEqual([back.event.startTime?.value, back.event.numChildren?.value], ["14:00", 15], "a read-back of what the family said is never dropped");
    // A read-back of what the family never said is the team's question, unanswered: left out.
    const unsaidRefs = refsOf([["family", "Hi, a party for our son please. (ZZ TEST)"], ["team", readBack]]);
    const unsaid = resolveCatalogueAnswer({ event: { numChildren: { value: 12, line: 2 } } }, catalogue, unsaidRefs);
    assert.equal(withoutUnansweredQuestions(unsaid, unsaidRefs), 1);
    assert.equal(unsaid.event.numChildren, undefined);
  });

  // --- The review of 20 November: the code check, tightened and loosened -------------------------
  await check("onlyTheFamilysFirstTurnAfterAQuestionAnswersIt", () => {
    const offer = "Would you like to add the bubble show at 15:00 for 1,500 baht? (ZZ TEST)";
    const after = (...lines: Array<["family" | "team", string]>) => refsOf([["family", FAMILY_ASKS], ["team", offer], ...lines]);
    const asked = (refs: TranscriptRef[]) => unansweredQuestion(team(2), refs, null, ["the bubble show"]);
    assert.equal(asked(after(["family", "(ZZ TEST) Can you send me the address please?"])), true, "a reply that only asks back is no answer");
    assert.equal(
      asked(after(["family", "Can you send me the address please?"], ["team", "ZZ TEST road 1, Phuket."], ["family", "Thanks!"])),
      true,
      "a later turn of the family's is not the answer",
    );
    assert.equal(asked(after(["family", "Yes please! (ZZ TEST)"])), false, "the first turn answers");
    assert.equal(asked(after(["family", "Can you send me the address?"], ["family", "And yes to the show. (ZZ TEST)"])), false, "a turn of two lines, one answering");
    assert.equal(asked(after(["team", "It is 40 minutes. (ZZ TEST)"], ["family", "Perfect, thank you. (ZZ TEST)"])), false, "the family's first turn, after more of the team's lines");
  });

  await check("aThaiConfirmationAsksOnlyInItsLastClause", () => {
    const thai = "ยืนยันงานวันเสาร์ เวลา 14:00 เด็ก 15 คน รับเค้กเพิ่มไหมคะ";
    assert.equal(saidAsQuestion(thai, ["14:00"]), false, "the confirmed time");
    assert.equal(saidAsQuestion(thai, ["15 คน"]), false, "the confirmed children");
    assert.equal(saidAsQuestion(thai, ["เค้ก"]), true, "the cake it asks about");
    assert.equal(saidAsQuestion(`${thai}?`, ["14:00"]), false, "with a question mark too");
    const refs = refsOf([["family", "สวัสดีค่ะ (ZZ TEST)"], ["team", thai]]);
    const p = resolveCatalogueAnswer(
      { event: { startTime: { value: "14:00", line: 2 }, numChildren: { value: 15, said: "เด็ก 15 คน", line: 2 } }, cake: { mode: "INTERNAL", notes: "รับเค้กเพิ่ม", line: 2 } },
      catalogue,
      refs,
    );
    assert.equal(withoutUnansweredQuestions(p, refs), 1);
    assert.deepEqual([p.event.startTime?.value, p.event.numChildren?.value, p.cake], ["14:00", 15, null]);
  });

  await check("theFormsReadAsksTheCakeByItsOwnWords", () => {
    const message = "Confirmed: 12 kids at 14:00. Would you like us to make the birthday cake? (ZZ TEST)";
    for (const cake of [{ cakeMode: "INTERNAL" }, { cakeQuantity: 1 }, { cakePrice: 500 }, { cakeIncluded: true }]) {
      const read = { event: { numChildren: 12 }, kitchenPlan: { ...cake } };
      assert.equal(fillWithoutUnansweredQuestions(read as never, message), 1, JSON.stringify(cake));
      assert.deepEqual(read.kitchenPlan, {}, `${JSON.stringify(cake)}: the cake it only asks about goes`);
      assert.deepEqual(read.event, { numChildren: 12 });
    }
    const said = { kitchenPlan: { cakeMode: "INTERNAL" } };
    assert.equal(fillWithoutUnansweredQuestions(said as never, "Confirmed: the chocolate cake from the park. Would you like extra candles? (ZZ TEST)"), 0);
    assert.deepEqual(said.kitchenPlan, { cakeMode: "INTERNAL" }, "a cake the message confirms stays");
    const cupcakes = { kitchenPlan: { cakeMode: "INTERNAL" } };
    assert.equal(fillWithoutUnansweredQuestions(cupcakes as never, "Cupcakes for the kids are ready. Would you like a cake as well? (ZZ TEST)"), 1, "cupcakes are not the cake");
  });

  await check("aDishsCountOrPriceTheTeamOnlyAskedIsNotAgreed", () => {
    const refs = refsOf([["family", "We'd like pizza for the kids please. (ZZ TEST)"], ["team", "Shall we make it 3 pizzas at 450 each? (ZZ TEST)"]]);
    const line = { productCode: null, notInMenu: true, itemName: "pizza", menu: "kids", quantity: 3, chatPrice: 450, line: 1 };
    const p = resolveCatalogueAnswer({ menuLines: [line] }, catalogue, refs);
    assert.equal(withoutUnansweredQuestions(p, refs), 2);
    assert.deepEqual(p.menuLines.map((l) => [l.itemName, l.quantity, l.chatPrice]), [["pizza", 1, null]], "the dish the family asked for, with no count or price of the question's");
    const yes = refsOf([["family", "We'd like pizza for the kids please. (ZZ TEST)"], ["team", "Shall we make it 3 pizzas at 450 each? (ZZ TEST)"], ["family", "Yes, perfect. (ZZ TEST)"]]);
    const agreed = resolveCatalogueAnswer({ menuLines: [line] }, catalogue, yes);
    assert.equal(withoutUnansweredQuestions(agreed, yes), 0);
    assert.deepEqual(agreed.menuLines.map((l) => [l.quantity, l.chatPrice]), [[3, 450]], "answered: as before");
    const own = refsOf([["family", "3 pizzas for the kids please. (ZZ TEST)"], ["team", "Shall we make it 3 pizzas at 450 each? (ZZ TEST)"]]);
    const said = resolveCatalogueAnswer({ menuLines: [{ ...line, chatPrice: null }] }, catalogue, own);
    assert.equal(withoutUnansweredQuestions(said, own), 0);
    assert.equal(said.menuLines[0]?.quantity, 3, "a count the family's own line says");
  });

  await check("aPastedExchangeHoldsItsOwnAnswer", async () => {
    const two = "Team: Would you like the bubble show at 15:00? (ZZ TEST)\nMum: Yes please! (ZZ TEST)";
    const pastedRef = (text: string): TranscriptRef[] => [{ line: 1, id: "pasted", source: "team", at: at(0), ruling: true, text }];
    assert.equal(unansweredQuestion(team(1), pastedRef(two), null, ["the bubble show"]), false, "the other speaker said yes");
    assert.equal(unansweredQuestion(team(1), pastedRef("Team: Would you like the bubble show at 15:00? (ZZ TEST)\nMum: (ZZ TEST) Can you send the address?"), null, ["the bubble show"]), true);
    assert.equal(unansweredQuestion(team(1), pastedRef("Date: Saturday\nTime: 14:00\nWould you like the bubble show at 15:00? (ZZ TEST)"), null, ["the bubble show"]), true, "a confirmation's own labels answer nothing");
    // Keyed by the reply's own words: the transcript the model reads indents the paste's second line.
    conversationAnswers.set("Mum: Yes please! (ZZ TEST)", { catalogue: { entertainment: [{ templateId: cat.bubble, said: "the bubble show at 15:00", time: "15:00", line: 1 }] } });
    const res = await post("/api/ai/parse-beo", { text: two, existingData: { event: { title: "ZZ TEST" } }, eventId: ev.pasted });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body.review.proposal as BeoAiProposal).entertainment.length, 1, "the show the family said yes to stays");
  });

  // SCRUM-1030 (the review asked): the editor's pasted AI Fill reads a park's pasted text as a
  // one-line conversation, with the conversation's own keys, so it proposes Kitchen Notes too.
  await check("aPastedMessagesKitchenNotesReachTheReview", async () => {
    const pasted = "Mum: Please, no chilli in any of the food, and cut everything small. (ZZ TEST pasted notes)";
    conversationAnswers.set("(ZZ TEST pasted notes)", {
      catalogue: { kitchenNotes: { value: "no chilli in any of the food, and cut everything small", said: "no chilli in any of the food", line: 1, source: "family" } },
    });
    const res = await post("/api/ai/parse-beo", { text: pasted, existingData: { event: { title: "ZZ TEST" } }, eventId: ev.notes });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const notes = (res.body.review.proposal as BeoAiProposal).details.kitchenNotes;
    assert.equal(notes?.value, "no chilli in any of the food, and cut everything small");
    assert.ok(modelCalls.some((c) => c.system.includes("THE CONVERSATION") && c.user.includes("(ZZ TEST pasted notes)")), "read with the conversation's keys");
  });

  await check("onTheRouteTheReviewTeamAndActivityRowHoldNoQuestion", async () => {
    // The conversation's read and, with the team's last line the RULING, the ruling message's own read
    // too, each written by a model that ignored the rule.
    inbox.set(conv.ruled, transcriptOf("ruled", [["customer", FAMILY_ASKS], ["staff", TEAM_ASKS]], 1));
    formAnswers.set(TEAM_ASKS, {
      summary: "ZZ",
      event: { locationText: "Jungle Room" },
      setupPlan: { readyBy: "13:30", simplifiedTasks: [{ itemLabel: "a balloon arch" }] },
      partyDetails: { items: [{ description: "a candy bar", type: "extra" }] },
      timeline: [{ time: "15:45", label: "a piñata" }],
      team: { partyHost: "Nok" },
    });
    // "open": the conversation alone, no confirmation of the team's yet.
    inbox.set(conv.open, transcriptOf("open", [["customer", FAMILY_ASKS], ["staff", TEAM_ASKS]], null));
    for (const key of ["open", "ruled"] as const) {
      const res = await fill(key);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const review: BeoAiReview = res.body.review;
      assert.deepEqual(questionsLeft(review.proposal), [], `${key}: the review proposes none of the team's questions`);
      assert.equal(res.body.fill.proposals.partyHost, null, `${key}: the host the team only asked about is not proposed`);
      assert.equal(review.proposal.details.kitchenNotes?.value, "no peanuts in anything please");
      const rows = await q("select metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at desc limit 1", [`%${ev[key]}%`]);
      const meta = JSON.parse(rows[0]!.metadata_json);
      assert.ok(meta.unanswered >= ALL_ASKED.length - 1, `${key}: the activity row counts them (${meta.unanswered})`);
      for (const w of ["bubble", "Hawaiian", "piñata", "Jungle", "peanut"]) assert.ok(!rows[0]!.metadata_json.includes(w), "never the chat's words");
      // Approve and create writes nothing of them.
      const state = initialReviewState(review, { fill: res.body.fill, bookedDate: BOOKED });
      const body = approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null });
      assert.equal(body.entertainment.length, 0);
      assert.ok(!body.menuLines.some((l) => /hawaiian|lemonade/i.test(l.itemName)));
      assert.equal(body.details?.timeline, undefined);
      assert.equal(body.cake, null);
      const ok = await approve(key, body);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const acts = await q("select custom_name from beo_entertainment_items where event_id = $1", [ev[key]]);
      assert.equal(acts.length, 0, `${key}: no show`);
      const typed = await q("select label from beo_timeline_items where event_id = $1 and is_system_generated = false", [ev[key]]);
      assert.equal(typed.length, 0, `${key}: no typed step`);
      const plan = (await q("select menus, cake_time, kitchen_notes from beo_kitchen_plans where event_id = $1", [ev[key]]))[0]!;
      assert.ok(!JSON.stringify(plan.menus).includes("Hawaiian"), `${key}: no extra pizza`);
      assert.equal(plan.cake_time, null, `${key}: no cake time`);
      assert.equal(plan.kitchen_notes, "no peanuts in anything please", `${key}: the family's own words are the Kitchen Notes`);
      const evRow = (await q("select location_text from core_events where id = $1", [ev[key]]))[0]!;
      assert.equal(evRow.location_text, null, `${key}: no room the team only offered`);
    }
    // The ruling message's own read (Load into Editor, and Fetch from chat where the conversation
    // gives nothing) holds none of them either; with the family answering after it, all stay.
    const ruled = await fill("ruled");
    const f = ruled.body.fill;
    assert.deepEqual(
      [f.event?.locationText, f.setupPlan?.readyBy, f.setupPlan?.simplifiedTasks, f.partyDetails?.items, f.timeline, f.team?.partyHost],
      [undefined, undefined, [], [], [], undefined],
      "the form's read keeps no question",
    );
    inbox.set(conv.answered, transcriptOf("answered", [["customer", FAMILY_ASKS], ["staff", TEAM_ASKS], ["customer", FAMILY_YES]], 1));
    conversationAnswers.set(FAMILY_YES, { catalogue: answerFor(2) });
    const yes = await fill("answered");
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.deepEqual(questionsLeft(yes.body.review.proposal), ALL_ASKED, "answered: every one is proposed");
    assert.deepEqual([yes.body.fill.setupPlan?.readyBy, yes.body.fill.timeline?.length, yes.body.fill.proposals.partyHost?.match?.id], ["13:30", 1, nok], "and the form's read keeps them");
    const rows = await q("select metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1", [`%${ev.answered}%`]);
    assert.equal(JSON.parse(rows[0]!.metadata_json).unanswered, undefined, "nothing left out, nothing counted");
  });

  await check("aConfirmationsQuestionsLeaveTheFormsReadToo", () => {
    const message = "Confirmed: 12 kids at 14:00, Margherita pizza. Shall we add a candy bar? Would you like the cake at 16:00? (ZZ TEST)";
    const read = {
      event: { numChildren: 12, startTime: "14:00", decoration: "a candy bar" },
      kitchenPlan: { kidsMenu: [{ itemName: "Margherita pizza", quantity: 1 }, { itemName: "a candy bar", quantity: 1 }], cakeMode: "INTERNAL" as const, cakeTime: "16:00" },
      timeline: [{ time: "16:00", label: "the cake" }],
    };
    const refused = fillWithoutUnansweredQuestions(read as never, message);
    assert.equal(refused, 4);
    assert.deepEqual(read.event, { numChildren: 12, startTime: "14:00" }, "what it confirms stays");
    assert.deepEqual(read.kitchenPlan, { kidsMenu: [{ itemName: "Margherita pizza", quantity: 1 }] }, "the cake it only asks about goes whole");
    assert.deepEqual(read.timeline, []);
  });

  await check("aPastedConfirmationThatAsksIsNotAgreed", async () => {
    // SCRUM-818's pasted message: one line of the team's; a question it asks has no answer in it.
    const pasted = "Confirmed: ZZ Test Lina's party, 12 kids, Margherita pizza. Would you like to add the bubble show at 15:00? (ZZ TEST pasted)";
    conversationAnswers.set(pasted, {
      catalogue: {
        setMenu: { templateId: cat.setMenu, line: 1, choices: [{ itemId: PIZZA, option: "Margherita", said: "Margherita pizza", line: 1 }] },
        entertainment: [{ templateId: cat.bubble, said: "the bubble show at 15:00", time: "15:00", line: 1 }],
        event: { numChildren: { value: 12, line: 1 } },
      },
    });
    const res = await post("/api/ai/parse-beo", { text: pasted, existingData: { event: { title: "ZZ TEST" } }, eventId: ev.pasted });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p: BeoAiProposal = res.body.review.proposal;
    assert.equal(p.entertainment.length, 0, "the show it only asks about");
    assert.deepEqual([p.setMenu?.choices.map((c) => c.option), p.event.numChildren?.value], [["Margherita"], 12], "what it confirms stays");
  });

  // --- SCRUM-1030: the Kitchen Notes ------------------------------------------------------------
  await check("theKitchenNotesAreProposedShownAndWrittenOnlyOnApproval", async () => {
    const asks = "Hi, a party for ZZ Test Remy, 10 kids. No chilli in any of the food please, and serve the fruit after the cake. (ZZ TEST)";
    inbox.set(conv.notes, transcriptOf("notes", [["customer", asks]], null));
    conversationAnswers.set(asks, {
      catalogue: {
        event: { numChildren: { value: 10, line: 1 } },
        kitchenNotes: { value: "No chilli in any of the food please, and serve the fruit after the cake.", said: "No chilli in any of the food please", line: 1, source: "team" },
      },
    });
    const res = await fill("notes");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    const notes = review.proposal.details.kitchenNotes!;
    assert.equal(notes.value, "No chilli in any of the food please, and serve the fruit after the cake.");
    assert.deepEqual([notes.from.source, notes.from.line, notes.from.quote], ["family", 1, "No chilli in any of the food please"], "the line's author, never the model's say-so, and the chat's words");
    assert.equal((await q("select kitchen_notes from beo_kitchen_plans where event_id = $1", [ev.notes]))[0]?.kitchen_notes ?? null, null, "nothing written by the fill");
    // The review: the row with the chat's words, as the other proposals have them.
    const state = initialReviewState(review, { fill: res.body.fill });
    assert.equal(state.details.kitchenNotes.value, notes.value);
    const page = html(review, state);
    assert.ok(page.includes('data-testid="ai-review-detail-kitchenNotes"') && page.includes("Kitchen notes:"), "the Kitchen notes row");
    assert.ok(page.indexOf("Kitchen notes:") < page.indexOf("Set menu:"), "first in the Kitchen Plan, as the Staff BEO prints them");
    assert.ok(page.includes("The chat says “No chilli in any of the food please”"), "with the chat's words under it");
    // Approve and create writes it to the kitchen plan, and says so.
    const body = approveBodyOf(review, state, ids);
    assert.equal(body.details?.kitchenNotes, notes.value);
    assert.ok(body.sources.some((s) => s.field === "kitchenNotes" && s.source === "family"));
    assert.ok(APPROVED_SECTIONS["kitchen-plan"]!("kitchenNotes"), "the form's Kitchen part wears the chip");
    const ok = await approve("notes", body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.written.kitchenNotes, true);
    assert.match(approvalResultWords(ok.body), /Saved: .*the kitchen plan/);
    assert.equal((await q("select kitchen_notes from beo_kitchen_plans where event_id = $1", [ev.notes]))[0]!.kitchen_notes, notes.value);
    // The BEO's own read answers it, for the editor and the Staff BEO.
    const beo = await fetch(`${base}/api/events/${ev.notes}/beo`, { headers: { "x-test-as": "manager" } }).then((r) => r.json() as Promise<any>);
    assert.equal(beo.kitchenPlan?.kitchenNotes, notes.value);
  });

  await check("kitchenNotesTheFormHoldsAreNeverOverwritten", async () => {
    await q("insert into beo_kitchen_plans (event_id, kitchen_notes) values ($1, 'ZZ TEST no nuts at all (typed by staff)')", [ev.held]);
    const proposal: BeoAiProposal = {
      package: null, addOns: [], setMenu: null, menuLines: [], entertainment: [], otherLines: [], event: {}, cake: null, deposit: null,
      details: { ...emptyBeoAiDetails(), kitchenNotes: { value: "no chilli please", from: { ...family(1), quote: "no chilli please" } } },
    };
    const review = { origin: "inbox", proposal, catalogue, finalMessage: null, ruling: null, transcript: { lines: 1, cut: false }, replaces: [], parentSelection: null } as BeoAiReview;
    const held = { title: "", bookingName: "", locationText: "", specialRequests: "", activities: "", decoration: "", setupReadyBy: "", setupResponsible: "", posName: "", posNotes: "", kitchenNotes: "ZZ TEST no nuts at all (typed by staff)" };
    const state = initialReviewState(review, { held, saved: held });
    assert.equal(state.details.kitchenNotes.value, "ZZ TEST no nuts at all (typed by staff)", "the form's own text stays in the field");
    assert.equal(state.details.kitchenNotes.chat, "no chilli please", "the chat's is offered beside it");
    const page = html(review, state);
    assert.ok(page.includes('data-testid="button-ai-review-use-chat-kitchenNotes"'), "taken only with a press");
    const body = approveBodyOf(review, state, ids);
    assert.equal(body.details?.kitchenNotes, undefined, "the saved text is not written back over itself");
    // A proposal from a server before this rule: no Kitchen Notes, nothing sent.
    const older = { ...review, proposal: { ...proposal, details: emptyBeoAiDetails() } } as BeoAiReview;
    const olderState = initialReviewState(older, {});
    assert.equal(olderState.details.kitchenNotes.value, "");
    assert.ok(!html(older, olderState).includes("Kitchen notes:"), "no row when there is nothing to show");
    assert.equal(approveBodyOf(older, olderState, ids).details?.kitchenNotes, undefined);
    const ok = await approve("held", approveBodyOf(older, olderState, ids));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await q("select kitchen_notes from beo_kitchen_plans where event_id = $1", [ev.held]))[0]!.kitchen_notes, "ZZ TEST no nuts at all (typed by staff)");
  });

  // --- SCRUM-1050: no typed row for a step the Timeline makes itself -------------------------------
  await check("noTypedRowForAStepTheTimelineMakes", () => {
    const f = family(1);
    const proposal = {
      entertainment: [{ templateId: cat.bubble, name: "Bubble show", said: "the bubble show", quantity: 1, chatPrice: null, notInCatalogue: false, time: "15:00", from: f }],
      event: { startTime: { value: "14:00", from: f }, kidsFoodTime: { value: "15:30", from: f }, adultsFoodTime: { value: "15:40", from: f }, barServiceTime: { value: "14:15", from: f } },
      cake: { mode: "INTERNAL" as const, notes: null, time: "16:00", from: f },
      menuLines: [],
      setMenu: { templateId: cat.setMenu, from: f, choices: [{ itemId: PIZZA, option: "Margherita", said: "Margherita pizza", from: f }] },
      details: { ...emptyBeoAiDetails(), setup: { readyBy: { value: "13:30", from: f }, responsible: null, tasks: [] } },
    };
    const made: Array<[string, string]> = [
      ["13:30", "Setup ready"], ["13:30", "Room decorated and ready"], ["14:00", "Guests arrive"], ["14:00", "Welcome the guests"], ["14:00", "check-in"],
      ["15:30", "Lunch"], ["15:30", "Kids' food served"], ["15:30", "Margherita pizza for the kids"], ["15:40", "Adults' meal"], ["14:15", "Drinks"],
      ["16:00", "Cake"], ["15:00", "Bubble show"], ["15:20", "Bubble show"],
    ];
    for (const [time, label] of made) assert.equal(timedElsewhere({ time, label }, proposal), true, `${time} ${label}: the Timeline makes it`);
    const own: Array<[string, string]> = [["13:30", "A piñata"], ["15:30", "Lunch and games"], ["15:00", "Photo session"], ["14:00", "Treasure hunt"], ["17:00", "Lunch"]];
    for (const [time, label] of own) assert.equal(timedElsewhere({ time, label }, proposal), false, `${time} ${label}: a moment of its own stays`);
    // The read: a show with no time takes the step's; with a time, its own stands; the piñata stays.
    const refs = refsOf([["family", "The bubble show at 15:10, the cake at 16:00, lunch at 15:30, and a piñata at 13:45 please. (ZZ TEST)"]]);
    const p = resolveCatalogueAnswer(
      {
        entertainment: [{ templateId: cat.bubble, said: "The bubble show", line: 1 }],
        event: { startTime: { value: "14:00", line: 1 }, kidsFoodTime: { value: "15:30", said: "lunch at 15:30", line: 1 } },
        cake: { mode: "INTERNAL", time: "16:00", line: 1 },
        timeline: [
          { time: "15:10", label: "Bubble show", line: 1 },
          { time: "16:00", label: "Cake", line: 1 },
          { time: "15:30", label: "Lunch", line: 1 },
          { time: "14:00", label: "Party starts", line: 1 },
          { time: "13:45", label: "Piñata", line: 1 },
        ],
      },
      catalogue,
      refs,
    );
    // The review: a show with no time makes no step of its own, so the chat's step for it stays a
    // typed step; nothing moves into the show.
    assert.deepEqual(p.details.timeline.map((t) => [t.time, t.label]), [["13:45", "Piñata"], ["15:10", "Bubble show"]], "the moments the Timeline does not make");
    assert.equal(p.entertainment[0]?.time, undefined, "the show keeps no time the chat gave only to a step");
    // A step the team only asked about is not proposed at all.
    const askedRefs = refsOf([["family", "The bubble show please. (ZZ TEST)"], ["team", "Shall we do the bubble show at 15:10? (ZZ TEST)"]]);
    const asked = resolveCatalogueAnswer({ entertainment: [{ templateId: cat.bubble, said: "The bubble show", line: 1 }], timeline: [{ time: "15:10", label: "Bubble show", line: 2 }] }, catalogue, askedRefs);
    withoutUnansweredQuestions(asked, askedRefs);
    assert.deepEqual([asked.entertainment[0]?.time, asked.details.timeline.length], [undefined, 0]);
    // The ruling message's own read, against what the BEO already holds (its start, ready-by and cake).
    const empty: BeoAiProposal = { package: null, addOns: [], setMenu: null, menuLines: [], entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, details: emptyBeoAiDetails() };
    const details = detailsFromFill(empty, { timeline: [
      { time: "13:30", label: "Setup ready" }, { time: "14:00", label: "Guests arrive" }, { time: "16:00", label: "Cake" }, { time: "15:45", label: "Piñata" },
    ] }, {
      existingData: { event: { startTime: "14:00" }, setupPlan: { readyBy: "13:30" }, kitchenPlan: { cakeMode: "INTERNAL", cakeTime: "16:00" } },
      from: team(1),
      event: null,
    });
    assert.deepEqual(details.timeline.map((t) => [t.time, t.label]), [["15:45", "Piñata"]]);
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_timeline_items where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from beo_set_menu_selections where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from package_line_item_templates where package_template_id = $1", [cat.pkg]).catch(() => undefined);
  await q("delete from birthday_package_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from entertainment_package_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_set_menu_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from employees where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from users where id = $1", [manager]).catch(() => undefined);
  await q("delete from branches where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from tenants where id = $1", [tenant]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== CHECKS ? 1 : 0);
