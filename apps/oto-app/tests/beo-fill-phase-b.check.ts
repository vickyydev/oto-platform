// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub platform api) and needs a database
// whose otoapp schema the app's migrator has built. It renders the review's
// own component, so it runs with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-904 (Phase B, the owner's go of 12 November) — the conversation's read
// fills EVERY field of the BEO form, each with the chat's own words, whose
// line and when, so a chat only the family has written still proposes it all:
//   - the conversation block of the prompt asks the whole form (booking name,
//     location, the date with its words, the age, the WhatsApp number, the
//     food and bar times, the setup plan, the POS box with prices, the hosts,
//     the cake's count and price, a dish's note, allergies, a show's time),
//     never a default or a guess, and no longer assumes a RULING line; it
//     reaches the model under a park group's SAVED advice and format too;
//   - the resolver keeps what the chat gives and nothing else: no invented
//     time or price, a phone number only when its line holds its digits, a
//     real calendar day only; the option of a shared till code the chat names
//     (SCRUM-926: "chicken fried rice" is Fried rice (Chicken)); the same dish
//     as a set-menu choice and a menu line is one line (its note on the
//     choice); a show the entertainment times is not a second timeline step;
//   - a long line is quoted around the value's own words;
//   - the review proposes it all with a reason line under each row (the Date
//     row and the Team rows too), and every guard holds: nothing written
//     before Approve and create; the date and a host apply only when ticked;
//     a deposit only the family claims opens as asked; typed text is never
//     overwritten (the allergy is offered beside it, first in Special
//     requests); the chat's words never ride the approval or the activity row;
//   - Approve and create writes every field where the BEO keeps it, the shows
//     as Entertainment Acts (at the chat's time when it gives one), never
//     twice;
//   - a catalogue that could not be read is said so, not called empty;
//   - Fetch from chat offers the same fields, beside what is typed, and never
//     a deposit only the family claims as received.
//
// Every model answer here is scripted: no model key is used.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-fill-phase-b.check.ts
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
  console.error("beo-fill-phase-b.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-904";
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
const { resolveCatalogueAnswer, loadBeoCatalogue, quoteOf, beoCatalogueSystemBlock, emptyCatalogue, BEO_CONVERSATION_FORM_RULES, BEO_CONVERSATION_RULES, phoneInLine } =
  await import("../server/lib/beoCatalogueFill");
const { foodNameFor } = await import("../shared/beoAiFill");
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, undecidedLines, NOTHING_HELD, requestsOfField } = await import("../client/src/lib/beo-ai-review");
const { fetchChangesOf, fetchCatalogueChangesOf } = await import("../client/src/lib/beo-fetch-from-chat");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
type TranscriptRef = import("../server/lib/beoCatalogueFill").TranscriptRef;
type FetchFormValues = import("../client/src/lib/beo-fetch-from-chat").FetchFormValues;

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
const CHECKS = 8;

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const manager = randomUUID();
const nok = randomUUID();
const cat = { floresta: randomUUID(), setMenu: randomUUID(), bubble: randomUUID(), face: randomUUID() };
const KEYS = ["family", "unread", "held"] as const;
type Key = (typeof KEYS)[number];
const ev = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const conv = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const PIZZA = "item_904_pizza";
const RICE = "item_904_fried_rice";
const BOOKED = "2099-11-21";
const CHAT_DAY = "2099-12-05";

// The set menu: a pizza group whose options carry their own codes, and a fried-rice group
// whose three options share the group's one code (CF-43), as the park's menu has it.
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" } },
  { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Pork"], allowMultiple: false, productCode: "CF-43", optionProductCodes: {} },
  { id: "item_904_fries", type: "always_included", label: "French fries", productCode: "CF-11" },
];

/** The owner's case: only the family writes, and names everything the form holds. */
const FAMILY_TEXTS = [
  "Hi! Lina's 6th birthday on Saturday 5 December, 14:00 to 16:30, 12 kids and 8 adults. Booking under ZZ TEST Anna. PHASEB-904",
  "In the Party Room please. Hawaiian pizza for the kids but no cheese on it, chicken fried rice for the adults. One of the kids is allergic to peanuts. PHASEB-904",
  "Bubble show at 15:00 please, and the face painting. Kids' food at 14:30, adults' food at 15:00, drinks from 14:15. PHASEB-904",
  "2 chocolate cakes from the park, 800 baht each? Room ready by 13:30 with a balloon arch, keep it away from the stage. Nok as the host. My WhatsApp is +66 81 234 5678. PHASEB-904",
  "We already transferred the 3,000 baht deposit. Bill it as the Floresta package with an extra pizza for 450. PHASEB-904",
];
const at = (i: number) => new Date(Date.UTC(2026, 10, 3, 7, i * 7)).toISOString();
type TLine = { id: string; author: "customer" | "staff"; at: string; text: string };
const familyLines = (key: Key): TLine[] => FAMILY_TEXTS.map((text, i) => ({ id: `${conv[key]}-${i}`, author: "customer", at: at(i), text }));

/**
 * The conversation's read, as the prompt asks it: every field with its words and its line. On
 * purpose: the Hawaiian pizza is both a set-menu choice and a kids' menu line (one line, its
 * note on the choice); the chicken fried rice names a code three options share; the bubble show
 * is timed and also a timeline step (one act, no second step); the deposit is the family's word.
 */
const FAMILY_ANSWER = {
  catalogue: {
    package: { templateId: cat.floresta, said: "the Floresta package", line: 5 },
    setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: PIZZA, option: "Hawaiian", said: "Hawaiian pizza", line: 2 }] },
    menuLines: [
      { productCode: "CF-27", itemName: "Hawaiian pizza", menu: "kids", quantity: 1, notes: "no cheese on it", line: 2 },
      { productCode: "CF-43", itemName: "chicken fried rice", menu: "adults", quantity: 1, line: 2 },
    ],
    entertainment: [
      { templateId: cat.bubble, said: "Bubble show", quantity: 1, time: "15:00", line: 3 },
      { templateId: cat.face, said: "the face painting", quantity: 1, line: 3 },
    ],
    event: {
      childName: { value: "Lina", line: 1 },
      numChildren: { value: 12, line: 1 },
      numAdults: { value: 8, line: 1 },
      startTime: { value: "14:00", line: 1 },
      endTime: { value: "16:30", line: 1 },
      bookingName: { value: "ZZ TEST Anna", said: "Booking under ZZ TEST Anna", line: 1 },
      locationText: { value: "Party Room", said: "In the Party Room", line: 2 },
      eventDate: { value: CHAT_DAY, said: "Saturday 5 December", line: 1 },
      childAge: { value: 6, said: "6th birthday", line: 1 },
      whatsapp: { value: "+66 81 234 5678", said: "My WhatsApp is +66 81 234 5678", line: 4 },
      kidsFoodTime: { value: "14:30", said: "Kids' food at 14:30", line: 3 },
      adultsFoodTime: { value: "15:00", said: "adults' food at 15:00", line: 3 },
      barServiceTime: { value: "14:15", said: "drinks from 14:15", line: 3 },
    },
    cake: { mode: "internal", notes: "chocolate cakes", quantity: 2, included: false, price: "800", line: 4 },
    deposit: { amount: "3,000", paid: true, line: 5 },
    requests: [{ kind: "allergy", text: "allergic to peanuts", line: 2 }],
    timeline: [{ time: "15:00", label: "Bubble show", line: 3 }],
    setup: {
      readyBy: { value: "13:30", said: "Room ready by 13:30", line: 4 },
      notes: { value: "keep it away from the stage", said: "keep it away from the stage", line: 4 },
      tasks: [{ label: "a balloon arch", line: 4 }],
    },
    pos: {
      name: { value: "Floresta package", said: "the Floresta package", line: 5 },
      items: [{ description: "extra pizza", type: "extra", price: 450, line: 5 }],
    },
    team: { partyHost: { value: "Nok", said: "Nok as the host", line: 4 } },
  },
};

const SAVED_ADVICE = "ZZ TEST SAVED ADVICE 904: read the party.";
const SAVED_FORMAT = '{ "summary": "", "event": { "childName": "" } }';
const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    if (call.user.includes("PHASEB-904") && call.system.includes("THE CONVERSATION")) return JSON.stringify(FAMILY_ANSWER);
    return JSON.stringify({ summary: "ZZ plain", event: { childName: "Plain" } });
  },
};
let catalogueDown = false;
const inbox = new Map<string, InboxRead>(
  KEYS.map((key) => [
    conv[key],
    { ok: true, confirmation: { conversationId: conv[key], eventId: ev[key], message: null, scanned: FAMILY_TEXTS.length, transcript: familyLines(key), transcriptCut: false } },
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
  // The park group's SAVED advice and output format, as staging has them: the conversation block reaches the model all the same.
  readSetting: async (_req, key) => (key === "ai_beo_parsing_advice" ? SAVED_ADVICE : key === "ai_beo_parsing_output_format" ? SAVED_FORMAT : null),
  inboxConfirmation: async (_req, conversationId) => inbox.get(conversationId) ?? { ok: false, reason: "inbox_unreachable" },
  catalogue: async (event) => {
    if (catalogueDown) throw new Error("ZZ the catalogue is down");
    return loadBeoCatalogue(db, { tenantId: event.tenantId, branchId: event.branchId });
  },
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

/** What the BEO holds: every table an approval writes. */
async function beoRows(eventId: string) {
  return {
    event: (await q("select * from core_events where id = $1", [eventId]))[0]!,
    kitchen: (await q("select * from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null,
    bar: (await q("select * from beo_bar_plans where event_id = $1", [eventId]))[0] ?? null,
    setup: (await q("select * from beo_setup_plans where event_id = $1", [eventId]))[0] ?? null,
    acts: await q("select custom_name, start_time, sort_order from beo_entertainment_items where event_id = $1 order by sort_order", [eventId]),
    entertainment: await q("select name from beo_entertainment_selections where event_id = $1 order by sort_order", [eventId]),
    billing: (await q("select * from beo_event_billing where event_id = $1", [eventId]))[0] ?? null,
    host: (await q("select * from beo_party_host_assignments where event_id = $1", [eventId]))[0] ?? null,
    activity: await q("select summary_text, metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at", [`%${eventId}%`]),
  };
}
const family = (line: number) => ({ source: "family", at: at(line - 1), line });
const fromOf = (f: { source: string; at: string | null; line: number | null } | null | undefined) => (f ? { source: f.source, at: f.at, line: f.line } : f);

let familyReview: BeoAiReview | null = null;
let familyFill: unknown = null;

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 904 ${run}`, `zz-904-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, 'ZZ TEST Central Floresta 904', 'ZZ TEST', 'Asia/Bangkok')", [park, tenant]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 904', 'manager', true, false)", [
    manager, `zz-904-${manager.slice(0, 8)}@example.com`,
  ]);
  await q(`insert into employees (id, tenant_id, full_name, nickname, email, branch_id, employment_state) values ($1, $2, 'ZZ TEST Siriporn 904', 'Nok', $3, $4, 'ACTIVE')`, [
    nok, tenant, `zz-904-${nok.slice(0, 8)}@example.com`, park,
  ]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Birthday set menu 904', $3)", [cat.setMenu, tenant, JSON.stringify(setMenuItems)]);
  await q(
    `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours,
       price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, set_menu_template_id, branch_id, sort_order)
     values ($1, $2, 'Birthday package 904', 1690000, 10, 4, -1, 3, 1690000, 2090000, 130000, 150000, $3, $4, 1)`,
    [cat.floresta, tenant, cat.setMenu, park],
  );
  await q(
    `insert into entertainment_package_templates (id, tenant_id, name, category, duration_minutes, default_price, billable_by_default, unit, sort_order)
     values ($1, $3, 'Bubble show', 'Shows', 30, 550000, true, 'session', 1), ($2, $3, 'Face painting', 'Other', 60, 200000, true, 'hour', 2)`,
    [cat.bubble, cat.face, tenant],
  );
  for (const key of KEYS) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, status, inbox_conversation_id)
       values ($1, $2, $3, 'birthday', $4, $5, '10:00', 'tentative', $6)`,
      [ev[key], tenant, park, `ZZ TEST 904 ${key}`, BOOKED, conv[key]],
    );
  }

  await check("theConversationBlockAsksTheWholeForm", async () => {
    // The block itself: every field of the form, its words and its line, never a default; no RULING assumed.
    const block = beoCatalogueSystemBlock(emptyCatalogue(), { conversation: true });
    assert.ok(block.includes(BEO_CONVERSATION_FORM_RULES), "the rest of the form rides the conversation's read");
    for (const key of [
      '"bookingName"', '"locationText"', '"eventDate"', '"childAge"', '"whatsapp"', '"kidsFoodTime"', '"adultsFoodTime"', '"barServiceTime"',
      '"readyBy"', '"responsible"', '"tasks"', '"pos"', '"partyHost"', '"entertainmentHost"', '"quantity"', '"included"', '"allergy"', '"notes"', '"time"',
    ]) {
      assert.ok(block.includes(key), `the block names ${key}`);
    }
    assert.ok(BEO_CONVERSATION_FORM_RULES.includes("never a default, a usual time, a guess or a price the conversation does not name"), "nothing invented");
    assert.ok(BEO_CONVERSATION_FORM_RULES.includes('"said", the conversation\'s own words for it exactly as written'), "every value with the chat's own words");
    assert.ok(BEO_CONVERSATION_RULES.includes("The team may not have confirmed the party yet: then no line is marked RULING"), "no RULING line assumed");
    assert.ok(!BEO_CONVERSATION_RULES.includes("from the RULING line alone"), "the old wording is gone");
    assert.ok(!beoCatalogueSystemBlock(emptyCatalogue(), { conversation: false }).includes("THE REST OF THE FORM"), "a pasted read keeps its own block");
    // On the route, with the park group's SAVED advice and format: the block reaches the model all the same.
    const before = modelCalls.length;
    const res = await fill(ev.family);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const calls = modelCalls.slice(before);
    assert.equal(calls.length, 1, "no message of the team's: the conversation's read alone");
    assert.ok(calls[0]!.system.startsWith(SAVED_ADVICE), "the saved advice leads");
    assert.ok(calls[0]!.system.includes("THE REST OF THE FORM, FROM THE CONVERSATION") && calls[0]!.system.includes('"kidsFoodTime"'), "the form's rules reach the model under the saved advice");
    familyReview = res.body.review;
    familyFill = res.body.fill;
  });

  await check("everyFieldFromTheChatWithItsWords", async () => {
    const review = familyReview!;
    assert.ok(review, "the review opened");
    assert.equal(review.ruling, null, "nothing confirmed by the team");
    const p = review.proposal;
    const words = (f: { from: { quote?: string } } | null | undefined) => f?.from.quote;
    // The event's fields, each with the chat's words and the family's line.
    assert.deepEqual(p.event.eventDate && { ...p.event.eventDate, from: fromOf(p.event.eventDate.from) }, { value: CHAT_DAY, said: "Saturday 5 December", from: family(1) });
    assert.equal(words(p.event.eventDate), "Saturday 5 December");
    assert.equal(p.event.childAge?.value, 6);
    assert.equal(words(p.event.childAge), "6th birthday");
    assert.equal(p.event.whatsapp?.value, "+66 81 234 5678");
    assert.deepEqual(fromOf(p.event.whatsapp?.from), family(4));
    assert.deepEqual([p.event.kidsFoodTime?.value, p.event.adultsFoodTime?.value, p.event.barServiceTime?.value], ["14:30", "15:00", "14:15"]);
    assert.equal(words(p.event.barServiceTime), "drinks from 14:15");
    assert.deepEqual([p.details.bookingName?.value, words(p.details.bookingName)], ["ZZ TEST Anna", "Booking under ZZ TEST Anna"]);
    assert.deepEqual([p.details.locationText?.value, words(p.details.locationText)], ["Party Room", "In the Party Room"]);
    // The setup plan, the POS box with the price the chat names, the hosts.
    assert.deepEqual([p.details.setup.readyBy?.value, words(p.details.setup.readyBy)], ["13:30", "Room ready by 13:30"]);
    assert.deepEqual(p.details.setup.tasks.map((t) => [t.itemLabel, t.from.quote]), [["a balloon arch", "a balloon arch"]]);
    assert.equal(p.details.setup.notes?.value, "keep it away from the stage");
    assert.deepEqual([p.details.pos.name?.value, words(p.details.pos.name)], ["Floresta package", "the Floresta package"]);
    assert.deepEqual(p.details.pos.items.map((i) => [i.description, i.type, i.price]), [["extra pizza", "extra", 450]]);
    const host = (familyFill as any).proposals.partyHost;
    assert.equal(host.match?.id, nok, "the host the family names, matched to the park's roster");
    assert.deepEqual({ ...fromOf(host.from), quote: host.from.quote }, { ...family(4), quote: "Nok as the host" }, "with the family's words for it");
    // The cake's count, package and price — only as the chat says them.
    assert.deepEqual([p.cake?.mode, p.cake?.quantity, p.cake?.included, p.cake?.price], ["INTERNAL", 2, false, 800]);
    // One pizza line: the set menu's choice, the family's note on it; the chicken fried rice is that option.
    assert.deepEqual(p.setMenu?.choices.map((c) => [c.itemId, c.option, c.notes]), [[PIZZA, "Hawaiian", "no cheese on it"]]);
    assert.deepEqual(p.menuLines.map((l) => [l.menu, l.itemName, l.productCode, l.matchedName]), [["adults", "chicken fried rice", "CF-43", "Fried rice (Chicken)"]], "SCRUM-926: the option the chat names, not the first");
    // The bubble show timed: an act at 15:00, not a second timeline step.
    assert.deepEqual(p.entertainment.map((e) => [e.templateId, e.time ?? null]), [[cat.bubble, "15:00"], [cat.face, null]]);
    assert.deepEqual(p.details.timeline, [], "the timed show is its act, not a step");
    // The allergy is its own kind, kept for Special requests.
    assert.deepEqual(p.details.requests.map((r) => [r.kind, r.text, r.from.quote]), [["allergy", "allergic to peanuts", "allergic to peanuts"]]);
    assert.deepEqual(p.deposit && [p.deposit.amount, p.deposit.paid, p.deposit.from.source], [3000, true, "family"], "the model reads the family's word as paid");
    // Nothing is written by the fill; the activity row and the logs hold counts, never the chat's words.
    const rows = await beoRows(ev.family);
    assert.equal(rows.kitchen, null);
    assert.equal(rows.bar, null);
    assert.equal(rows.setup, null);
    assert.deepEqual(rows.acts, []);
    assert.deepEqual(rows.entertainment, []);
    assert.equal(rows.billing, null);
    assert.equal(rows.host, null);
    assert.equal(rows.event.event_date, BOOKED);
    assert.equal(rows.event.kid_turning_age, null);
    assert.equal(rows.event.whatsapp_phone_raw, null);
    const meta = JSON.parse(rows.activity.at(-1)!.metadata_json);
    assert.equal(meta.catalogue.event, 6, "the event's six new fields, counted");
    assert.equal(meta.catalogue.allergies, 1);
    assert.equal(meta.catalogue.acts, 1);
    const said = ["Lina", "Anna", "Party Room", "peanuts", "234 5678", "balloon arch", "no cheese", "chocolate", "transferred", "Saturday 5 December", ...FAMILY_TEXTS];
    for (const w of said) {
      assert.ok(!rows.activity.some((r) => r.metadata_json.includes(w) || r.summary_text.includes(w)), `no "${w}" in the activity row`);
      assert.ok(!logged.some((l) => l.includes(w)), `no "${w}" in the logs`);
    }
  });

  await check("theReviewProposesItWithTheGuards", async () => {
    const review = familyReview!;
    const held = { ...NOTHING_HELD, specialRequests: "ZZ typed by staff" };
    const state = initialReviewState(review, { fill: familyFill, bookedDate: BOOKED, held, saved: held });
    // The Date row: the chat's day beside the booked one, its words and line; applied only when ticked.
    assert.deepEqual(state.date && { read: state.date.read, readText: state.date.readText, booked: state.date.booked, differs: state.date.differs }, {
      read: CHAT_DAY, readText: "Saturday 5 December", booked: BOOKED, differs: true,
    });
    assert.deepEqual(fromOf(state.date?.from), family(1));
    assert.equal(state.useDate, false, "the date waits for a tick");
    assert.equal(state.childAge?.value, 6);
    assert.deepEqual([state.kidsFoodTime?.value, state.adultsFoodTime?.value, state.barServiceTime?.value], ["14:30", "15:00", "14:15"]);
    assert.equal(state.details.whatsapp.value, "+66 81 234 5678", "the form holds no number: the chat's");
    // Typed text is never overwritten: the allergy is offered beside it, first in Special requests.
    assert.equal(state.details.specialRequests.value, "ZZ typed by staff");
    assert.equal(state.details.specialRequests.chat, "Allergy: allergic to peanuts");
    assert.deepEqual(requestsOfField([
      { kind: "special_request", text: "a quiet corner", from: family(2) },
      { kind: "allergy", text: "nuts", from: family(3) },
    ], "special_request").map((r) => r.kind), ["allergy", "special_request"], "allergies first");
    // A deposit only the family says was paid opens as asked; nobody assigned until ticked.
    assert.equal(state.deposit?.value.paid, false);
    assert.deepEqual(state.details.team.accepted, []);
    assert.equal(undecidedLines(state), 0, "every line the chat names is the catalogue's");
    const body = approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null });
    assert.equal(body.event.eventDate, undefined, "an unticked date is not sent");
    assert.equal(body.details?.team, undefined, "an unticked host is not sent");
    assert.equal(body.details?.specialRequests, undefined, "typed text is the form's");
    assert.deepEqual(body.deposit, { amount: 3000, paid: false, date: null }, "the family's claim is sent as asked");
    assert.equal(body.event.kidTurningAge, 6);
    assert.equal(body.event.whatsappPhoneRaw, "+66 81 234 5678");
    assert.deepEqual(body.service, { kidsFoodTime: "14:30", adultsFoodTime: "15:00", barServiceTime: "14:15" });
    assert.deepEqual(body.cake, { mode: "INTERNAL", notes: "chocolate cakes", time: null, quantity: 2, included: false, price: 800 });
    assert.deepEqual(body.setMenu, { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Hawaiian"], notes: "no cheese on it" }] });
    assert.deepEqual(body.menuLines, [{ menu: "adults", itemName: "chicken fried rice", quantity: 1, productCode: "CF-43", notes: null }]);
    assert.deepEqual(body.entertainment.map((e) => [e.templateId, e.time ?? null]), [[cat.bubble, "15:00"], [cat.face, null]]);
    assert.deepEqual(body.details?.posItems, [{ description: "extra pizza", type: "extra", price: 450 }]);
    assert.equal(body.details?.setupNotes, "keep it away from the stage");
    const json = JSON.stringify(body);
    assert.ok(!json.includes("quote") && FAMILY_TEXTS.every((t) => !json.includes(t)) && !json.includes("6th birthday"), "the chat's words never ride the approval");
    // Ticked, the date and the host are sent.
    const ticked = { ...state, useDate: true, details: { ...state.details, team: { ...state.details.team, accepted: ["partyHost" as const] } } };
    const tickedBody = approveBodyOf(review, ticked, { conversationId: review.conversationId ?? null, messageId: null });
    assert.equal(tickedBody.event.eventDate, CHAT_DAY);
    assert.deepEqual(tickedBody.details?.team?.partyHost, { kind: "employee", id: nok, label: (familyFill as any).proposals.partyHost.match.label });
    assert.equal(tickedBody.sources.find((s) => s.field === "team:partyHost")?.source, "family", "the host's mark is the family's line");
    // A number the form already holds, written another way, is not offered again.
    const same = initialReviewState(review, { held: { ...NOTHING_HELD, whatsapp: "081 234 5678" }, saved: { ...NOTHING_HELD, whatsapp: "081 234 5678" } });
    assert.equal(same.details.whatsapp.chat, null);
    assert.equal(approveBodyOf(review, same, { conversationId: null, messageId: null }).event.whatsappPhoneRaw, undefined);
    // The review shows a reason line under the Date row, the Age, the Team row and every new row.
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
    for (const quote of ["Saturday 5 December", "6th birthday", "Nok as the host", "Kids&#x27; food at 14:30", "drinks from 14:15", "Room ready by 13:30", "In the Party Room", "allergic to peanuts"]) {
      assert.ok(html.includes(`The chat says “${quote}”`), `a reason line: ${quote}`);
    }
    const dateRow = html.slice(html.indexOf('data-testid="ai-review-event-date"'), html.indexOf('data-testid="text-ai-review-date-differs"'));
    assert.ok(dateRow.includes("text-ai-review-chat-says") && !dateRow.includes("— the message says"), "the Date row speaks as every row does");
    assert.ok(html.includes("· Tue 3 Nov 14:21"), "the time of the family's line, on the park's clock");
    for (const id of ["input-ai-review-childAge", "input-ai-review-cake-quantity", "checkbox-ai-review-cake-included", "text-ai-review-choice-notes", "input-ai-review-entertainment-time", "input-ai-review-pos-item-price"]) {
      assert.ok(html.includes(`data-testid="${id}"`), `the review shows ${id}`);
    }
    assert.ok(html.includes("Note: no cheese on it — written on the dish&#x27;s line."), "the note on the set menu's pizza");
    assert.ok(html.includes("— added to Entertainment Acts, which puts it on the Timeline.") && html.includes("— added to Entertainment Acts with no time: the chat gives none."), "every show becomes an act");
    // A dish line of its own carries its note in a field the reviewer can change.
    const noted = { ...state, menuLines: state.menuLines.map((l) => ({ ...l, notes: "extra spicy" })) };
    assert.ok(renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state: noted, onChange: () => undefined })).includes('data-testid="input-ai-review-menu-notes"'));
    assert.equal(approveBodyOf(review, noted, { conversationId: null, messageId: null }).menuLines[0]?.notes, "extra spicy");
  });

  await check("approvalWritesEveryFieldAndTheActsOnce", async () => {
    const review = familyReview!;
    const state = initialReviewState(review, { fill: familyFill, bookedDate: BOOKED });
    // Unticked first: the date and the host stay as booked.
    const res = await approve(ev.family, approveBodyOf(review, state, { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let rows = await beoRows(ev.family);
    assert.equal(rows.event.event_date, BOOKED, "unticked: the booked date stands");
    assert.equal(rows.host, null, "unticked: nobody assigned");
    assert.equal(rows.event.kid_turning_age, 6);
    assert.equal(rows.event.whatsapp_phone_raw, "+66 81 234 5678");
    assert.equal(rows.event.booking_name, "ZZ TEST Anna");
    assert.equal(rows.event.location_text, "Party Room");
    assert.equal(rows.event.special_requests, "Allergy: allergic to peanuts", "the allergy in Special requests");
    // The kitchen plan: the food's times, the cake's count, package and price, the dish's note, the option the chat names.
    assert.equal(rows.kitchen.menus.kidsFoodTime, "14:30");
    assert.equal(rows.kitchen.menus.adultsFoodTime, "15:00");
    assert.equal(rows.kitchen.menus.cakeIncluded, false);
    assert.equal(rows.kitchen.menus.cakePrice, 800);
    assert.equal(rows.kitchen.cake_quantity, 2);
    const hawaiian = (rows.kitchen.menus.kids as any[]).find((l) => l.itemName === "Hawaiian");
    assert.ok(hawaiian?.notes.includes("no cheese on it"), `the note on the dish's line: ${JSON.stringify(hawaiian)}`);
    const rice = (rows.kitchen.menus.adults as any[]).filter((l) => l.source !== "set_menu");
    assert.deepEqual(rice.map((l) => [l.itemName, l.notes]), [["Fried rice (Chicken)", "CF-43"]], "SCRUM-926: written as the option the chat names");
    assert.equal(rows.bar.service_time, "14:15");
    assert.equal(rows.setup.setup_notes, "keep it away from the stage");
    assert.equal(rows.setup.setup_tasks.readyBy, "13:30");
    // Every show is an Entertainment Act: the bubble show at 15:00, the face painting waiting for a time.
    assert.deepEqual(rows.acts.map((a) => [a.custom_name, a.start_time]), [["Bubble show", "15:00"], ["Face painting", null]]);
    assert.deepEqual(rows.entertainment.map((e) => e.name), ["Bubble show", "Face painting"]);
    // The family's claim stays asked: no money received.
    assert.equal(rows.billing.deposit_paid, false);
    assert.equal(rows.billing.deposit_amount, 3000);
    // Ticked, a second approval: the date and the host apply; the acts are not added twice.
    const ticked = { ...state, useDate: true, details: { ...state.details, team: { ...state.details.team, accepted: ["partyHost" as const] } } };
    const again = await approve(ev.family, approveBodyOf(review, ticked, { conversationId: review.conversationId ?? null, messageId: null }));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    rows = await beoRows(ev.family);
    assert.equal(rows.event.event_date, CHAT_DAY, "ticked: the chat's date");
    assert.equal(rows.host?.assigned_employee_id, nok, "ticked: the host assigned");
    assert.deepEqual(rows.acts.map((a) => [a.custom_name, a.start_time]), [["Bubble show", "15:00"], ["Face painting", null]], "never twice");
    for (const r of rows.activity) for (const t of FAMILY_TEXTS) assert.ok(!r.metadata_json.includes(t), "no line of the chat in the activity row");
    // The BEO's own read shows the POS item at the chat's price.
    const beo = await fetch(`${base}/api/events/${ev.family}/beo`, { headers: { "x-test-as": "manager" } }).then((r) => r.json() as Promise<any>);
    const item = (beo.partyDetails?.items ?? []).find((i: any) => i.description === "extra pizza");
    assert.equal(item?.price, 450, JSON.stringify(beo.partyDetails));
    assert.ok(!(Number(beo.partyDetails?.prepaymentReceived) > 0), "no prepayment received");
  });

  await check("nothingInventedAndOneLinePerDish", () => {
    const refs: TranscriptRef[] = FAMILY_TEXTS.map((text, i) => ({ line: i + 1, id: `l${i}`, source: "family", at: at(i), ruling: false, text }));
    const catalogue = {
      packages: [],
      setMenus: [{ id: cat.setMenu, name: "Birthday set menu 904", items: setMenuItems as any }],
      entertainment: [],
      food: [
        { code: "CF-27", names: ["Hawaiian"] },
        { code: "CF-43", names: ["Fried rice (Veggie)", "Fried rice (Chicken)", "Fried rice (Pork)"] },
      ],
    };
    const p = resolveCatalogueAnswer(
      {
        event: {
          kidsFoodTime: { value: "", line: 3 },
          adultsFoodTime: { said: "adults' food later", line: 3 },
          whatsapp: { value: "+66 99 999 9999", line: 4 }, // not in its line: the model's own
          eventDate: { value: "2099-02-30", line: 1 }, // no such day
          childAge: { value: 200, line: 1 },
        },
        cake: { line: 4 },
        pos: { items: [{ description: "extra pizza", line: 5 }] },
        setMenu: { templateId: cat.setMenu, line: 2, choices: [{ itemId: RICE, option: "chicken", said: "chicken fried rice", line: 2 }] },
        menuLines: [
          { productCode: "CF-43", itemName: "chicken fried rice", menu: "kids", line: 2 },
          { productCode: "CF-43", itemName: "veggie fried rice", menu: "adults", line: 2 },
          { productCode: "CF-43", itemName: "pork fried rice", menu: "adults", line: 2 },
          { productCode: "CF-43", itemName: "pork fried rice", menu: "adults", quantity: 2, line: 3 },
        ],
        entertainment: [{ said: "a magician", time: "15:30", line: 3 }],
      },
      catalogue as any,
      refs,
    );
    assert.deepEqual(Object.keys(p.event), [], "no time, number, day or age the chat does not give");
    assert.equal(p.cake, null, "a cake with nothing said is no cake");
    assert.deepEqual(p.details.pos.items, [{ description: "extra pizza", type: "included", from: p.details.pos.items[0]!.from }], "no price the chat does not name");
    // The kids' chicken fried rice is the set menu's choice; the adults' options sharing CF-43 stay apart, one line each.
    assert.deepEqual(p.setMenu?.choices.map((c) => [c.itemId, c.option]), [[RICE, "Chicken"]]);
    assert.deepEqual(p.menuLines.map((l) => [l.menu, l.matchedName, l.quantity]), [["adults", "Fried rice (Veggie)", 1], ["adults", "Fried rice (Pork)", 2]]);
    assert.deepEqual(p.entertainment.map((e) => [e.name, e.notInCatalogue, e.time]), [["a magician", true, "15:30"]], "a free show keeps its time");
    // The option a shared code's names mean, from the chat's words.
    const rice = ["Fried rice (Veggie)", "Fried rice (Chicken)", "Fried rice (Pork)"];
    assert.equal(foodNameFor(rice, "Chicken fried rice please"), "Fried rice (Chicken)");
    assert.equal(foodNameFor(rice, "pork"), "Fried rice (Pork)");
    assert.equal(foodNameFor(rice, "fried rice"), "Fried rice (Veggie)", "no option named: the first");
    assert.equal(foodNameFor(["Margherita"], "pizza"), "Margherita");
    assert.equal(phoneInLine("+66 81 234 5678", FAMILY_TEXTS[3]!), true);
    assert.equal(phoneInLine("081 234 5678", "call 0812345678"), true);
    assert.equal(phoneInLine("+66 99 999 9999", FAMILY_TEXTS[3]!), false);
    assert.equal(phoneInLine("12", "12"), false, "too short to be a number");
  });

  await check("longLinesAreQuotedAroundTheValue", () => {
    const confirmation =
      "Confirmed: ZZ Test Niko's 8th birthday party on Sunday 6 December 2026, 11:00 to 13:30, 15 kids and 6 adults, Birthday package, Central Floresta, the Birthday set menu with Margherita pizza, Face painting, the park's cake at 12:30, booking name ZZ TEST Niko, in the Party Room. Deposit 3,000 THB asked.";
    const around = (quote: string | null, words: string) => {
      assert.ok(quote && quote.length <= 120, `at most 120 characters: ${quote}`);
      assert.ok(quote!.includes(words), `"${words}" in: ${quote}`);
      assert.ok(confirmation.includes(quote!.replace(/^…|…$/g, "")), `a piece of the line: ${quote}`);
    };
    around(quoteOf(null, confirmation, ["Party Room"]), "Party Room");
    around(quoteOf("the Party Room, please", confirmation, ["Party Room"]), "Party Room");
    around(quoteOf(null, confirmation, [3000]), "3,000");
    around(quoteOf(null, confirmation, ["12:30"]), "12:30");
    around(quoteOf(null, confirmation, ["6 adult", 6]), "6 adults");
    assert.equal(quoteOf("Face painting", confirmation, ["Face painting"]), "Face painting", "words the line holds: the words");
    assert.equal(quoteOf(null, "A short line.", ["x"]), "A short line.", "a short line: the line");
    assert.ok(quoteOf(null, confirmation, ["nothing here"])!.startsWith("Confirmed:"), "a value not found: the line's start, as before");
  });

  await check("aCatalogueThatCouldNotBeReadIsSaidSo", async () => {
    catalogueDown = true;
    try {
      const res = await fill(ev.unread);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const review: BeoAiReview = res.body.review;
      assert.equal(review.catalogueUnread, true);
      assert.ok(review.proposal.menuLines.length > 0 && review.proposal.menuLines.every((l) => l.notInMenu), "every dish a line to keep or leave out");
      assert.ok(review.proposal.entertainment.every((e) => e.notInCatalogue), "every show a line to keep or leave out");
      // The header's words are pinned where the editor mounts the dialog (beo-prefill-ui.check).
    } finally {
      catalogueDown = false;
    }
    const read = await fill(ev.held);
    assert.equal(read.body.review.catalogueUnread, undefined, "a catalogue that was read carries no flag");
  });

  await check("fetchFromChatOffersEveryFieldBesideTypedText", async () => {
    const review = familyReview!;
    const form: FetchFormValues = {
      title: "ZZ TEST", childName: "", bookingName: "", numChildren: null, numAdults: null, startTime: "10:00", endTime: "", eventDate: BOOKED,
      locationText: "", specialRequests: "ZZ typed by staff", activities: "", decoration: "", setupReadyBy: "", setupResponsible: "",
      cakeMode: "NONE", cakeNotes: "", cakeTime: "", prepaymentReceived: 0, depositDate: "", packageName: "", packageNotes: "",
      whatsappPhoneRaw: "", kidTurningAge: null, setupNotes: "", cakeQuantity: 1, cakeIncluded: "included", cakePrice: 0,
      kidsFoodTime: "", adultsFoodTime: "", barServiceTime: "",
    };
    const changes = fetchChangesOf({ fill: familyFill, review }, form);
    const by = Object.fromEntries(changes.map((c) => [c.field, c]));
    assert.equal(by.specialRequests?.value, "ZZ typed by staff\nAllergy: allergic to peanuts", "beside the typed text, never over it");
    assert.equal(by.prepaymentReceived, undefined, "the family's claim is never offered as received");
    assert.equal(by.depositDate, undefined);
    assert.equal(by.eventDate?.value, CHAT_DAY);
    assert.equal(by.eventDate?.from?.quote, "Saturday 5 December");
    assert.equal(by.kidTurningAge?.value, 6);
    assert.equal(by.whatsappPhoneRaw?.value, "+66 81 234 5678");
    assert.deepEqual([by.kidsFoodTime?.value, by.adultsFoodTime?.value, by.barServiceTime?.value], ["14:30", "15:00", "14:15"]);
    assert.deepEqual([by.cakeQuantity?.value, by.cakeIncluded?.value, by.cakePrice?.value], [2, "extra", 800]);
    assert.equal(by.setupNotes?.value, "keep it away from the stage");
    assert.equal(by.bookingName?.from?.quote, "Booking under ZZ TEST Anna", "the conversation's words, not the ruling's");
    assert.ok(changes.every((c) => c.from === null || c.from.source === "family" || c.from.source === "default"), "every change from the family's lines");
    // Typed text that already holds the chat's line is offered nothing.
    assert.equal(fetchChangesOf({ fill: familyFill, review }, { ...form, specialRequests: "ZZ typed\nallergic to peanuts" }).find((c) => c.field === "specialRequests"), undefined);
    // SCRUM-926: the Veggie fried rice the BEO holds is not the Chicken the chat names.
    const listed = fetchCatalogueChangesOf(review, {
      package: null, packageItems: [], setMenuTemplateId: cat.setMenu,
      menuLines: [{ itemName: "Fried rice (Veggie)", quantity: 1, productCode: "CF-43", groupId: null }],
      entertainment: [],
    }, form);
    assert.ok(listed.some((c) => c.section === "food" && c.now === "Fried rice (Chicken)"), JSON.stringify(listed));
    assert.ok(listed.some((c) => c.section === "entertainment" && c.now === "Bubble show at 15:00"));
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
  await q("delete from employees where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from users where id = $1", [manager]).catch(() => undefined);
  await q("delete from branches where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from tenants where id = $1", [tenant]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

process.stdout.write = writeOut;
console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== CHECKS ? 1 : 0);
