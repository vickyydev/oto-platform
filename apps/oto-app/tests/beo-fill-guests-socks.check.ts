// seed: its own — one ZZ TEST park group, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub inbox, a stub till menu) and needs a
// database whose otoapp schema the app's migrator has built. It renders the
// review's own component, so it runs with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// The BEO's assistant after the owner's answers of 19 November:
//   - SCRUM-1031 (the operations brief's E3 and E4): AI Fill reads from the chat
//     the expected EXTRA guests beyond the package (children, adults) and the
//     SOCKS arrangement (the editor's three options, "Other / Custom" with the
//     chat's words), and proposes them in the review like its other fields. The
//     SCRUM-1035 rule holds: an offer or a question of the team's that the family
//     did not answer is not written as agreed, and a number is proposed only when
//     the family stated it. Written only on approval, into the party's own four
//     columns (app migration 0054), on a party the till settles; nothing of them
//     goes to the till, the quote or a price (the owner's answer: "on the BEO and
//     the Staff BEO print only, not on the till").
//   - SCRUM-1030: "Fetch from chat" offers the Kitchen Notes AI Fill proposes,
//     beside what the form holds (the held text kept unless the chat's is taken),
//     and the expected extra guests and the socks arrangement as well.
//   - An older party, and a chat that names neither, get no proposal of them.
//
// Every model answer here is scripted: no model key is used, nothing is recorded.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-fill-guests-socks.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-fill-guests-socks.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1031";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const APP = fileURLToPath(new URL("../", import.meta.url));
const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const {
  loadBeoCatalogue, resolveCatalogueAnswer, withoutUnansweredQuestions, withoutGuestsSocksOffParty, guestCountStated, countWritten,
  beoCatalogueSystemBlock, BEO_CONVERSATION_OUTPUT_FORMAT, CONVERSATION_SHAPE,
} = await import("../server/lib/beoCatalogueFill");
type TranscriptRef = import("../server/lib/beoCatalogueFill").TranscriptRef;
const { requiredFieldsBlock, BEO_QUESTION_NOT_AGREED } = await import("../server/lib/aiFill");
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, approvalResultWords, APPROVED_SECTIONS } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
const { fetchChangesOf, applyFetchChanges, fetchedMarksOf, offeredChanges, rememberDeclined, NO_DECLINED, FETCH_LABELS } = await import("../client/src/lib/beo-fetch-from-chat");
const { emptyBeoAiDetails, BeoAiApproveBodySchema } = await import("../shared/beoAiFill");
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
type BeoAiProposal = import("../shared/beoAiFill").BeoAiProposal;
type BeoAiCatalogueView = import("../shared/beoAiFill").BeoAiCatalogueView;
type FetchFormValues = import("../client/src/lib/beo-fetch-from-chat").FetchFormValues;
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
const CHECKS = 13;
/** The code of a source file, its comments aside. */
const code = (path: string) => readFileSync(`${APP}${path}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const run = randomUUID().slice(0, 8);
const tenant = randomUUID();
const park = randomUUID();
const manager = randomUUID();
const KEYS = ["party", "camp", "older", "pasted", "asked", "kept", "fetch"] as const;
type Key = (typeof KEYS)[number];
const ev = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const conv = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const BOOKED = "2099-12-05";

// The conversation: the family states its extra guests and the socks; the team offers more and asks.
const FAMILY_SAYS =
  "Hi! A party for ZZ Test Mali on Saturday 5 December, 12 kids and 8 adults. My sister may bring her 2 kids too, and grandma pays for everyone's socks. No chilli in the food please. (ZZ TEST)";
const TEAM_OFFERS = "Thank you, noted! We can welcome up to 5 more adults. Shall we put all the socks on your bill? (ZZ TEST)";
const FAMILY_NAMES_NEITHER = "Hi! A party for ZZ Test Remy, 10 kids and 6 adults please. (ZZ TEST neither)";
const at = (i: number) => new Date(Date.UTC(2026, 10, 20, 9, i)).toISOString();
const family = (line: number) => ({ source: "family" as const, at: at(line - 1), line });
const team = (line: number) => ({ source: "team" as const, at: at(line - 1), line });
const refsOf = (lines: Array<["family" | "team", string]>): TranscriptRef[] =>
  lines.map(([source, text], i) => ({ line: i + 1, id: `r${i}`, source, at: at(i), ruling: false, text }));

/** The model's answer for that conversation, as a model that ignored the rule would give it: the team's offer and question as agreed. */
const answerFor = (offered: number) => ({
  event: {
    childName: { value: "ZZ Test Mali", line: 1 },
    numChildren: { value: 12, line: 1 },
    numAdults: { value: 8, line: 1 },
    expectedExtraKids: { value: 2, said: "My sister may bring her 2 kids too", line: 1, source: "family" },
    expectedExtraAdults: { value: 5, said: "We can welcome up to 5 more adults", line: offered, source: "family" },
    socks: { value: "other", note: "grandma pays for everyone's socks", said: "grandma pays for everyone's socks", line: 1, source: "family" },
  },
  kitchenNotes: { value: "No chilli in the food please", said: "No chilli in the food please", line: 1, source: "family" },
});

let catalogue: BeoAiCatalogueView;
const conversationAnswers = new Map<string, unknown>();
const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    if (call.system.includes("THE CONVERSATION")) for (const [mark, answer] of conversationAnswers) if (call.user.includes(mark)) return JSON.stringify(answer);
    return JSON.stringify({ summary: "ZZ plain" });
  },
};
const inbox = new Map<string, InboxRead>();
const transcriptOf = (key: Key, lines: Array<["customer" | "staff", string]>): InboxRead => ({
  ok: true,
  confirmation: {
    conversationId: conv[key],
    eventId: ev[key],
    message: null,
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
const servers: Server[] = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
registerAIRoutes(app, fakeAuth, {
  ai,
  readSetting: async () => null,
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
const fill = (key: Key, purpose?: "fetch") => post(`/api/events/${ev[key]}/beo/ai-fill/inbox`, { existingData: { event: { title: "ZZ TEST" } }, ...(purpose ? { purpose } : {}) });
const approve = (key: Key, body: unknown) => post(`/api/events/${ev[key]}/beo/ai-fill/approve`, body);
const html = (review: BeoAiReview, state: ReturnType<typeof initialReviewState>) =>
  renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
const ids = { conversationId: null, messageId: null };
const row = async (key: Key) =>
  (await q("select expected_extra_kids, expected_extra_adults, socks_arrangement, socks_note, title, num_children, num_adults, start_time, end_time from core_events where id = $1", [ev[key]]))[0]!;
const guestsSocksOf = (r: Record<string, unknown>) => [r.expected_extra_kids, r.expected_extra_adults, r.socks_arrangement, r.socks_note];
/** An approval naming only these event fields, nothing else of the BEO. */
const bareBody = (event: Record<string, unknown>) => ({ package: null, setMenu: null, menuLines: [], entertainment: [], otherLines: [], event, cake: null, deposit: null, sources: [] });
const emptyProposal = (): BeoAiProposal => ({ package: null, addOns: [], setMenu: null, menuLines: [], entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, details: emptyBeoAiDetails() });
const reviewOf = (proposal: BeoAiProposal): BeoAiReview =>
  ({ origin: "inbox", proposal, catalogue, finalMessage: null, ruling: null, transcript: { lines: 2, cut: false }, replaces: [], parentSelection: null, timeZone: "Asia/Bangkok" }) as BeoAiReview;
const FORM: FetchFormValues = {
  title: "ZZ TEST", childName: "", bookingName: "", numChildren: null, numAdults: null, startTime: "", endTime: "", eventDate: "",
  locationText: "", specialRequests: "", activities: "", decoration: "", setupReadyBy: "", setupResponsible: "", cakeMode: "NONE",
  cakeNotes: "", cakeTime: "", prepaymentReceived: 0, depositDate: "", packageName: "", packageNotes: "",
};

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 1031 ${run}`, `zz-1031-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, 'ZZ TEST Central Floresta 1031', 'ZZ TEST', 'Asia/Bangkok')", [park, tenant]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 1031', 'manager', true, false)", [
    manager, `zz-1031-${manager.slice(0, 8)}@example.com`,
  ]);
  for (const key of KEYS) {
    await q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, status, inbox_conversation_id, num_children, num_adults)
       values ($1, $2, $3, $4, $5, $6, '14:00', '16:30', 'tentative', $7, 12, 8)`,
      [ev[key], tenant, park, key === "camp" ? "camp" : "birthday", `ZZ TEST 1031 ${key}`, BOOKED, conv[key]],
    );
  }
  catalogue = await loadBeoCatalogue(db, { tenantId: tenant, branchId: park });

  // --- The words the model reads ------------------------------------------------------------
  await check("theInstructionsCarryTheNewFieldsAndTheRule", () => {
    const block = beoCatalogueSystemBlock(catalogue, { conversation: true });
    for (const piece of [
      '"event.expectedExtraKids" and "event.expectedExtraAdults": how many more children and adults than the party\'s planned guests the family says may come',
      "only a number the family itself writes, with the family's own line that writes it even when the team repeats it later",
      '"My sister may bring her 2 kids too" is 2 children',
      'A number the team offers or asks about ("We can welcome up to 5 more kids", "How many extra guests?") is not given unless a line of the family\'s writes it',
      "Never the planned guests themselves",
      '"event.socks": how the socks are paid for, as the family stated or agreed it: "birthday_parent"',
      '"guests" when each guest pays for their own, "other" for any other arrangement, with "note", the conversation\'s own words for it in at most 200 characters',
      '"The guests will buy their own socks" is "guests"',
      "An offer or a question of the team's that nobody answered (\"Shall we put all the socks on your bill?\") is not an arrangement",
    ]) {
      assert.ok(block.includes(piece), `the instructions say: ${piece}`);
    }
    for (const key of ['"expectedExtraKids": { "value": 0', '"expectedExtraAdults": { "value": 0', '"socks": { "value": "birthday_parent | guests | other", "note"']) {
      assert.ok(BEO_CONVERSATION_OUTPUT_FORMAT.includes(key), `the format names ${key}`);
    }
    const required = requiredFieldsBlock(CONVERSATION_SHAPE);
    for (const key of ["catalogue.event.expectedExtraKids.value: ", "catalogue.event.expectedExtraAdults.value: ", "catalogue.event.socks.value: ", "catalogue.event.socks.note: "]) {
      assert.ok(required.includes(`\n- ${key}`), `the fields the app requires name ${key}`);
    }
    // The form's own read (a message read alone, Load into Editor) is not asked them: only the conversation's.
    assert.ok(!beoCatalogueSystemBlock(catalogue, { conversation: false }).includes("expectedExtra"));
  });

  // --- The acceptance code ------------------------------------------------------------------
  await check("aCountIsTheFamilysOnlyWhenItsLineWritesIt", () => {
    assert.equal(countWritten("My sister may bring her 2 kids too (ZZ TEST)", 2), true);
    assert.equal(countWritten("Two more adults may come (ZZ TEST)", 2), true, "a word");
    assert.equal(countWritten("ZZ TEST one more child, maybe", 1), true);
    assert.equal(countWritten("เด็กเพิ่มอีกสองคนค่ะ (ZZ TEST)", 2), true, "Thai, written without spaces");
    assert.equal(countWritten("Придут ещё два взрослых (ZZ TEST)", 2), true, "Russian");
    assert.equal(countWritten("Party at 2 pm, extra kids may come (ZZ TEST)", 2), false, "the 2 of a clock time");
    assert.equal(countWritten("Party on 2/12, extra kids may come (ZZ TEST)", 2), false, "the 2 of a date");
    assert.equal(countWritten("My sister and her husband may come too (ZZ TEST)", 2), false, "a count the line does not write");
    assert.equal(countWritten("12 kids and 8 adults (ZZ TEST)", 2), false, "never the 2 of a 12");
    const refs = refsOf([["family", FAMILY_SAYS], ["team", TEAM_OFFERS]]);
    assert.equal(guestCountStated(2, family(1), refs), true, "the family's line writes it");
    assert.equal(guestCountStated(5, team(2), refs), false, "the team's offer is no number the family stated");
    assert.equal(guestCountStated(3, family(1), refs), false, "a number the family's line does not write");
    assert.equal(guestCountStated(2, family(9), refs), false, "a line the read does not hold");
    assert.equal(guestCountStated(2, { source: "team", at: null, line: null }, [], "Confirmed: 2 extra kids. (ZZ TEST)"), false, "the ruling message read alone is the team's");
    const pasted: TranscriptRef[] = [{ line: 1, id: "pasted", source: "team", at: at(0), ruling: true, text: "Mum: we may bring 3 extra kids (ZZ TEST)" }];
    assert.equal(guestCountStated(3, team(1), pasted), true, "a pasted text that writes it: the person who pasted it vouches");
    assert.equal(guestCountStated(4, team(1), pasted), false, "never one the paste does not write");
  });

  await check("theReadProposesWhatTheFamilyStatedAndNoOfferOrQuestion", () => {
    const refs = refsOf([["family", FAMILY_SAYS], ["team", TEAM_OFFERS]]);
    const read = resolveCatalogueAnswer(answerFor(2), catalogue, refs);
    assert.equal(read.event.expectedExtraKids?.value, 2);
    assert.equal(read.event.expectedExtraKids?.from.source, "family");
    assert.equal(read.event.expectedExtraKids?.from.quote, "My sister may bring her 2 kids too", "the chat's words for it");
    assert.equal(read.event.expectedExtraAdults, undefined, "the team's offer is not written as agreed, whatever the model said of its source");
    assert.deepEqual([read.event.socks?.value, read.event.socks?.note, read.event.socks?.from.source], ["other", "grandma pays for everyone's socks", "family"]);
    assert.equal(withoutUnansweredQuestions(read, refs), 0, "the family's own values are no question");
    assert.equal(read.event.expectedExtraKids?.value, 2);
    // The team's question nobody answered: no socks arrangement.
    const asked = resolveCatalogueAnswer(
      { event: { socks: { value: "birthday_parent", said: "Shall we put all the socks on your bill?", line: 2 } } },
      catalogue,
      refs,
    );
    assert.equal(asked.event.socks?.value, "birthday_parent", "read as the model gave it");
    assert.equal(withoutUnansweredQuestions(asked, refs), 1);
    assert.equal(asked.event.socks, undefined, "left out");
    // Answered by the family: it stands, from the family's answer.
    const yes = refsOf([["family", FAMILY_SAYS], ["team", TEAM_OFFERS], ["family", "Yes please, put the socks on our bill. (ZZ TEST)"]]);
    const agreed = resolveCatalogueAnswer({ event: { socks: { value: "birthday_parent", said: "put the socks on our bill", line: 3 } } }, catalogue, yes);
    assert.equal(withoutUnansweredQuestions(agreed, yes), 0);
    assert.deepEqual([agreed.event.socks?.value, agreed.event.socks?.from.source], ["birthday_parent", "family"]);
    // The team stating the arrangement (not asking): it stands, as the team's.
    const stated = refsOf([["family", FAMILY_NAMES_NEITHER], ["team", "Confirmed: the guests buy their own socks at reception. (ZZ TEST)"]]);
    const said = resolveCatalogueAnswer({ event: { socks: { value: "guests", said: "the guests buy their own socks", line: 2 } } }, catalogue, stated);
    assert.equal(withoutUnansweredQuestions(said, stated), 0);
    assert.deepEqual([said.event.socks?.value, said.event.socks?.from.source, said.event.socks?.note], ["guests", "team", undefined]);
    // A count the team repeats, given from the team's line: not the family's statement.
    const readBack = refsOf([["family", FAMILY_SAYS], ["team", "Noted: 2 extra kids may come. (ZZ TEST)"]]);
    assert.equal(resolveCatalogueAnswer({ event: { expectedExtraKids: { value: 2, line: 2 } } }, catalogue, readBack).event.expectedExtraKids, undefined);
    // Words with no number, a nought, an arrangement the editor has no option for, a note too long: none of them.
    const none = resolveCatalogueAnswer(
      {
        event: {
          expectedExtraKids: { value: 2, said: "a few friends may come", line: 1 },
          expectedExtraAdults: { value: 0, line: 1 },
          socks: { value: "pay_at_reception", line: 1 },
        },
      },
      catalogue,
      refsOf([["family", "Hi! A party for ZZ Test Kai, a few friends may come too, and socks at reception. (ZZ TEST)"]]),
    );
    assert.deepEqual([none.event.expectedExtraKids, none.event.expectedExtraAdults, none.event.socks], [undefined, undefined, undefined]);
    const long = resolveCatalogueAnswer({ event: { socks: { value: "other", note: "ZZ ".repeat(80), line: 1 } } }, catalogue, refsOf([["family", FAMILY_SAYS]]));
    assert.equal(long.event.socks, undefined, "a note the field cannot hold leaves the entry out");
    // A note goes only with "Other / Custom".
    const guests = resolveCatalogueAnswer({ event: { socks: { value: "Guests", note: "ZZ TEST stray", line: 1 } } }, catalogue, refsOf([["family", "The guests will buy their own socks. (ZZ TEST)"]]));
    assert.deepEqual([guests.event.socks?.value, guests.event.socks?.note], ["guests", undefined]);
    // Off a party the till settles (a camp): neither is proposed.
    const camp = resolveCatalogueAnswer(answerFor(2), catalogue, refs);
    withoutGuestsSocksOffParty(camp, "camp");
    assert.deepEqual([camp.event.expectedExtraKids, camp.event.socks, camp.event.numChildren?.value], [undefined, undefined, 12]);
    const party = resolveCatalogueAnswer(answerFor(2), catalogue, refs);
    withoutGuestsSocksOffParty(party, "birthday");
    assert.equal(party.event.expectedExtraKids?.value, 2);
  });

  await check("aPastedTextsNumberStandsAndItsUnansweredQuestionDoesNot", async () => {
    const said = "Mum: We may bring 3 extra kids, and the guests pay their own socks. (ZZ TEST pasted guests)";
    conversationAnswers.set("(ZZ TEST pasted guests)", {
      catalogue: { event: { expectedExtraKids: { value: 3, said: "We may bring 3 extra kids", line: 1 }, socks: { value: "guests", said: "the guests pay their own socks", line: 1 } } },
    });
    const res = await post("/api/ai/parse-beo", { text: said, existingData: { event: { title: "ZZ TEST" } }, eventId: ev.pasted });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p: BeoAiProposal = res.body.review.proposal;
    assert.deepEqual([p.event.expectedExtraKids?.value, p.event.socks?.value, p.event.expectedExtraKids?.from.source], [3, "guests", "team"], "a pasted text is the team's, for a person to check");
    const ask = "Team: Would you like to add 2 extra adults? We can also put the socks on your bill? (ZZ TEST pasted ask)";
    conversationAnswers.set("(ZZ TEST pasted ask)", {
      catalogue: { event: { expectedExtraAdults: { value: 2, said: "add 2 extra adults", line: 1 }, socks: { value: "birthday_parent", said: "put the socks on your bill", line: 1 } } },
    });
    const asked = await post("/api/ai/parse-beo", { text: ask, existingData: { event: { title: "ZZ TEST" } }, eventId: ev.pasted });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const left: BeoAiProposal = asked.body.review.proposal;
    assert.deepEqual([left.event.expectedExtraAdults, left.event.socks], [undefined, undefined], "a pasted question nobody answered is not agreed");
  });

  await check("onTheRouteAPartyGetsThemACampDoesNotAndNothingIsWritten", async () => {
    conversationAnswers.set(TEAM_OFFERS, { catalogue: answerFor(2) });
    for (const key of ["party", "camp"] as const) inbox.set(conv[key], transcriptOf(key, [["customer", FAMILY_SAYS], ["staff", TEAM_OFFERS]]));
    modelCalls.length = 0;
    const res = await fill("party");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // What the model read: the new fields' rule, and SCRUM-1035's after the catalogue, today last.
    const read = modelCalls.find((c) => c.system.includes("THE CONVERSATION"))!;
    assert.ok(read.system.includes('"event.socks": how the socks are paid for') && read.system.includes('"event.expectedExtraKids" and "event.expectedExtraAdults"'));
    assert.ok(read.system.indexOf(BEO_QUESTION_NOT_AGREED) > read.system.indexOf('"event.socks"'), "the question rule rides on the same read");
    assert.ok(read.system.lastIndexOf("Today at ") > read.system.indexOf(BEO_QUESTION_NOT_AGREED));
    const p: BeoAiProposal = res.body.review.proposal;
    assert.deepEqual([p.event.expectedExtraKids?.value, p.event.expectedExtraAdults, p.event.socks?.value, p.event.socks?.note], [2, undefined, "other", "grandma pays for everyone's socks"]);
    assert.deepEqual(guestsSocksOf(await row("party")), [null, null, null, null], "nothing written by the fill");
    const camp = await fill("camp");
    assert.equal(camp.status, 200, JSON.stringify(camp.body));
    const c: BeoAiProposal = camp.body.review.proposal;
    assert.deepEqual([c.event.expectedExtraKids, c.event.socks, c.event.numChildren?.value], [undefined, undefined, 12], "a camp is proposed neither");
    // The activity row: counts only, never the chat's words.
    const rows = await q("select metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at desc limit 1", [`%${ev.party}%`]);
    const meta = JSON.parse(rows[0]!.metadata_json);
    assert.ok(meta.catalogue.event >= 2, `the event's values are counted (${meta.catalogue.event})`);
    for (const w of ["grandma", "sister", "socks", "Mali"]) assert.ok(!rows[0]!.metadata_json.includes(w), `never the chat's words: ${w}`);
  });

  // --- The review --------------------------------------------------------------------------------
  await check("theReviewShowsTheRowsWithTheChatsWords", () => {
    const refs = refsOf([["family", FAMILY_SAYS], ["team", TEAM_OFFERS]]);
    const proposal = resolveCatalogueAnswer(answerFor(2), catalogue, refs);
    withoutUnansweredQuestions(proposal, refs);
    const review = reviewOf(proposal);
    const state = initialReviewState(review, {});
    assert.deepEqual([state.expectedExtraKids?.value, state.expectedExtraAdults, state.socks?.value], [2, null, { arrangement: "other", note: "grandma pays for everyone's socks" }]);
    const page = html(review, state);
    assert.ok(page.includes("Extra children:") && page.includes('data-testid="input-ai-review-expectedExtraKids"'), "the extra children row");
    assert.ok(!page.includes("Extra adults:"), "no row for what the chat does not give");
    assert.ok(page.includes("Socks:") && page.includes('data-testid="select-ai-review-socks"'), "the socks row");
    assert.match(page, /<option value="other" selected="">Other \/ Custom<\/option>/, "the chat's option chosen");
    for (const option of ["Not set", "Birthday Parent Pays", "Guests Pay Individually"]) assert.ok(page.includes(`>${option}</option>`), option);
    assert.match(page, /data-testid="input-ai-review-socks-note"[^>]*value="grandma pays for everyone&#x27;s socks"|value="grandma pays for everyone&#x27;s socks"[^>]*data-testid="input-ai-review-socks-note"/, "the note in its own box");
    assert.ok(page.includes("The chat says “My sister may bring her 2 kids too”"), "the chat's words under the count");
    assert.ok(page.includes("The chat says “grandma pays for everyone&#x27;s socks”"), "and under the socks");
    // In the Package part, after the package, as the editor's Event Info has them.
    assert.ok(page.indexOf("Extra children:") > page.indexOf('data-testid="select-ai-review-package"'));
    assert.ok(page.indexOf("Socks:") < page.indexOf("POS name:"));
    // Approve and create sends them, each with its source; the chip is Event Info's.
    const body = approveBodyOf(review, state, ids);
    assert.deepEqual([body.event.expectedExtraKids, body.event.expectedExtraAdults, body.event.socksArrangement, body.event.socksNote], [2, undefined, "other", "grandma pays for everyone's socks"]);
    assert.ok(body.sources.some((s) => s.field === "expectedExtraKids" && s.source === "family"));
    assert.ok(body.sources.some((s) => s.field === "socksArrangement" && s.source === "family"));
    assert.ok(BeoAiApproveBodySchema.safeParse(body).success, "the approval's own schema takes it");
    for (const f of ["expectedExtraKids", "expectedExtraAdults", "socksArrangement"]) assert.ok(APPROVED_SECTIONS["event-info"]!(f), f);
    // "Not set" sends no arrangement; another option sends no note; a reviewer's change is theirs.
    const notSet = approveBodyOf(review, { ...state, socks: { ...state.socks!, value: { arrangement: null, note: "x" }, changed: true } }, ids);
    assert.deepEqual([notSet.event.socksArrangement, notSet.event.socksNote], [undefined, undefined]);
    const guests = approveBodyOf(review, { ...state, socks: { ...state.socks!, value: { arrangement: "guests", note: "grandma" }, changed: true } }, ids);
    assert.deepEqual([guests.event.socksArrangement, guests.event.socksNote], ["guests", undefined]);
    assert.ok(guests.sources.some((s) => s.field === "socksArrangement" && s.source === "staff"));
    const emptied = approveBodyOf(review, { ...state, expectedExtraKids: null }, ids);
    assert.equal(emptied.event.expectedExtraKids, undefined, "a count the reviewer empties is not sent");
    // Nothing of them is money: the body names no price, no package and no line for them.
    assert.deepEqual([body.package, body.menuLines, body.cake, body.deposit], [null, [], null, null]);
  });

  // --- The approval ------------------------------------------------------------------------------
  await check("theApprovalWritesTheFourColumnsOnlyAndOnlyThen", async () => {
    const res = await fill("party");
    const review: BeoAiReview = res.body.review;
    const before = await row("party");
    const body = approveBodyOf(review, initialReviewState(review, { fill: res.body.fill, bookedDate: BOOKED }), ids);
    const ok = await approve("party", body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.written.event, true);
    assert.match(approvalResultWords(ok.body), /the event's details/);
    const after = await row("party");
    assert.deepEqual(guestsSocksOf(after), [2, null, "other", "grandma pays for everyone's socks"]);
    // The rest of the event as the review proposed it (the park's default title, the same counts and times).
    assert.equal(after.title, "ZZ Test Mali's Birthday");
    for (const k of ["num_children", "num_adults", "start_time", "end_time"]) assert.deepEqual(after[k], before[k], `${k} as it was`);
    // The read answers them, for the editor and the Staff BEO.
    const beo = await fetch(`${base}/api/events/${ev.party}/beo`, { headers: { "x-test-as": "manager" } }).then((r) => r.json() as Promise<any>);
    assert.deepEqual([beo.expectedExtraKids, beo.expectedExtraAdults, beo.socksArrangement, beo.socksNote], [2, null, "other", "grandma pays for everyone's socks"]);
  });

  await check("theSocksNoteGoesWithOtherAloneAndAStoredNoteIsKept", async () => {
    await q("update core_events set socks_arrangement = 'other', socks_note = 'ZZ TEST grandma pays (typed)', expected_extra_adults = 3 where id = $1", [ev.kept]);
    // "Other / Custom" with no words of the chat's: the party's own note stays; the count not named stays.
    const same = await approve("kept", bareBody({ socksArrangement: "other", expectedExtraKids: 1 }));
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.deepEqual(guestsSocksOf(await row("kept")), [1, 3, "other", "ZZ TEST grandma pays (typed)"]);
    const note = await approve("kept", bareBody({ socksArrangement: "other", socksNote: "ZZ TEST the school pays" }));
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.deepEqual(guestsSocksOf(await row("kept")), [1, 3, "other", "ZZ TEST the school pays"]);
    // Another option takes the note away, as the editor's Socks field does.
    const guests = await approve("kept", bareBody({ socksArrangement: "guests" }));
    assert.equal(guests.status, 200, JSON.stringify(guests.body));
    assert.deepEqual(guestsSocksOf(await row("kept")), [1, 3, "guests", null]);
    // What the schema refuses never reaches the party.
    for (const bad of [{ expectedExtraKids: -1 }, { expectedExtraKids: 1000 }, { expectedExtraKids: 1.5 }, { socksArrangement: "pay_at_reception" }, { socksNote: "" }, { socksNote: "x".repeat(201) }]) {
      const refused = await approve("kept", bareBody(bad));
      assert.equal(refused.status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(guestsSocksOf(await row("kept")), [1, 3, "guests", null]);
  });

  await check("aCampsApprovalWritesNoneOfThem", async () => {
    const ok = await approve("camp", bareBody({ expectedExtraKids: 4, expectedExtraAdults: 2, socksArrangement: "guests" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(guestsSocksOf(await row("camp")), [null, null, null, null]);
  });

  await check("anOlderPartyAndAChatNamingNeitherGetNoProposal", async () => {
    await q("update core_events set expected_extra_kids = 1, socks_arrangement = 'guests' where id = $1", [ev.older]);
    inbox.set(conv.older, transcriptOf("older", [["customer", FAMILY_NAMES_NEITHER]]));
    conversationAnswers.set(FAMILY_NAMES_NEITHER, { catalogue: { event: { numChildren: { value: 10, line: 1 }, numAdults: { value: 6, line: 1 } } } });
    const res = await fill("older");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    for (const k of ["expectedExtraKids", "expectedExtraAdults", "socks"]) assert.equal(k in review.proposal.event, false, `no ${k}`);
    const state = initialReviewState(review, { fill: res.body.fill });
    assert.deepEqual([state.expectedExtraKids, state.expectedExtraAdults, state.socks], [null, null, null]);
    const page = html(review, state);
    for (const label of ["Extra children:", "Extra adults:", "Socks:"]) assert.ok(!page.includes(label), `no ${label} row`);
    const body = approveBodyOf(review, state, ids);
    for (const k of ["expectedExtraKids", "expectedExtraAdults", "socksArrangement", "socksNote"]) assert.equal(k in body.event, false, `${k} not sent`);
    const ok = await approve("older", body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(guestsSocksOf(await row("older")), [1, null, "guests", null], "the party's own values stay");
    // Fetch from chat offers none of them either.
    const fetched = fetchChangesOf({ fill: res.body.fill, review }, { ...FORM, expectedExtraKids: 1, socksArrangement: "guests" });
    assert.equal(fetched.some((c) => ["expectedExtraKids", "expectedExtraAdults", "socksArrangement", "kitchenNotes"].includes(c.field)), false);
    // A proposal from a server before this rule: no field, no row, nothing sent.
    const older = reviewOf(emptyProposal());
    const olderState = initialReviewState(older, {});
    assert.deepEqual([olderState.expectedExtraKids, olderState.socks], [null, null]);
    const { expectedExtraKids: _k, expectedExtraAdults: _a, socks: _s, ...stateBefore } = olderState;
    assert.equal(approveBodyOf(older, stateBefore as typeof olderState, ids).event.socksArrangement, undefined, "a state made before the rule holds none");
  });

  // --- Fetch from chat ---------------------------------------------------------------------------
  await check("fetchFromChatOffersTheKitchenNotesBesideTheHeldText", async () => {
    const proposal = emptyProposal();
    proposal.details.kitchenNotes = { value: "No chilli in the food please", from: { ...family(1), quote: "No chilli in the food please" } };
    const answer = { fill: {}, review: reviewOf(proposal) };
    const typed = { ...FORM, kitchenNotes: "ZZ TEST no nuts at all (typed by staff)" };
    const changes = fetchChangesOf(answer, typed);
    assert.equal(changes.length, 1);
    const c = changes[0]!;
    assert.deepEqual([c.field, c.label, c.was, c.line, c.base], ["kitchenNotes", "Kitchen notes", "ZZ TEST no nuts at all (typed by staff)", "No chilli in the food please", "ZZ TEST no nuts at all (typed by staff)"]);
    assert.equal(c.now, "ZZ TEST no nuts at all (typed by staff)\nNo chilli in the food please", "beside what is typed, never in its place");
    assert.equal(c.from?.quote, "No chilli in the food please", "with the chat's words");
    assert.deepEqual(applyFetchChanges([c]), { kitchenNotes: "ZZ TEST no nuts at all (typed by staff)\nNo chilli in the food please" });
    assert.deepEqual(fetchedMarksOf([c]), { kitchenNotes: "family" });
    assert.ok(APPROVED_SECTIONS["kitchen-plan"]!("kitchenNotes"), "the Kitchen part wears the chip");
    // Declined: held on this chat; offered again once the chat moves.
    const held = rememberDeclined(NO_DECLINED, "m1", [c]);
    assert.deepEqual(offeredChanges(changes, held, "m1"), { offered: [], held: 1 });
    assert.equal(offeredChanges(changes, held, "m2").offered.length, 1);
    // An empty box takes the chat's words; a box that says them already is offered nothing.
    assert.equal(fetchChangesOf(answer, FORM)[0]?.now, "No chilli in the food please");
    assert.deepEqual(fetchChangesOf(answer, { ...FORM, kitchenNotes: "Allergy: no chilli in the food, please!" }), []);
    // On the route: the conversation read again offers them, as AI Fill's review proposes them.
    conversationAnswers.set("(ZZ TEST fetch)", {
      catalogue: { kitchenNotes: { value: "Cut everything small for the little ones", said: "Cut everything small for the little ones", line: 1 } },
    });
    inbox.set(conv.fetch, transcriptOf("fetch", [["customer", "Cut everything small for the little ones please. (ZZ TEST fetch)"]]));
    const res = await fill("fetch", "fetch");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const fetched = fetchChangesOf({ fill: res.body.fill, review: res.body.review }, typed);
    assert.deepEqual(fetched.map((x) => [x.field, x.line]), [["kitchenNotes", "Cut everything small for the little ones"]]);
    assert.equal((await q("select kitchen_notes from beo_kitchen_plans where event_id = $1", [ev.fetch]))[0]?.kitchen_notes ?? null, null, "nothing written by a fetch");
  });

  await check("fetchFromChatOffersTheExtraGuestsAndTheSocks", () => {
    const proposal = emptyProposal();
    proposal.event.expectedExtraKids = { value: 2, from: { ...family(1), quote: "My sister may bring her 2 kids too" } };
    proposal.event.socks = { value: "other", note: "grandma pays for everyone's socks", from: { ...family(1), quote: "grandma pays for everyone's socks" } };
    const answer = { fill: {}, review: reviewOf(proposal) };
    const changes = fetchChangesOf(answer, FORM);
    assert.deepEqual(changes.map((c) => [c.field, c.was, c.now]), [
      ["expectedExtraKids", "—", "2"],
      ["socksArrangement", "—", "Other / Custom: grandma pays for everyone's socks"],
    ]);
    assert.deepEqual([FETCH_LABELS.expectedExtraKids, FETCH_LABELS.socksArrangement], ["Extra children", "Socks"]);
    assert.deepEqual(applyFetchChanges(changes), { expectedExtraKids: 2, socksArrangement: "other", socksNote: "grandma pays for everyone's socks" });
    assert.deepEqual(fetchedMarksOf(changes), { expectedExtraKids: "family", socksArrangement: "family" });
    // What the form holds already is offered nothing.
    assert.deepEqual(fetchChangesOf(answer, { ...FORM, expectedExtraKids: 2, socksArrangement: "other", socksNote: "Grandma pays for everyone's socks " }).length, 1, "the note compared as written");
    assert.deepEqual(fetchChangesOf(answer, { ...FORM, expectedExtraKids: 2, socksArrangement: "other", socksNote: "grandma pays for everyone's socks" }), []);
    // Another option over "Other / Custom" takes the note away; "Other / Custom" with no words keeps the form's.
    const guests = emptyProposal();
    guests.event.socks = { value: "guests", from: family(1) };
    const overOther = fetchChangesOf({ fill: {}, review: reviewOf(guests) }, { ...FORM, socksArrangement: "other", socksNote: "ZZ TEST grandma" });
    assert.deepEqual(overOther.map((c) => [c.was, c.now]), [["Other / Custom: ZZ TEST grandma", "Guests Pay Individually"]]);
    assert.deepEqual(applyFetchChanges(overOther), { socksArrangement: "guests", socksNote: null });
    const bare = emptyProposal();
    bare.event.socks = { value: "other", from: family(1) };
    assert.deepEqual(fetchChangesOf({ fill: {}, review: reviewOf(bare) }, { ...FORM, socksArrangement: "other", socksNote: "ZZ TEST grandma" }), [], "the same option, no words of the chat's");
    const toOther = fetchChangesOf({ fill: {}, review: reviewOf(bare) }, { ...FORM, socksArrangement: "guests" });
    assert.deepEqual(applyFetchChanges(toOther), { socksArrangement: "other", socksNote: null });
    // A typed count is offered over, never cleared; a chat that gives none changes nothing.
    assert.deepEqual(fetchChangesOf(answer, { ...FORM, expectedExtraKids: 5 }).map((c) => [c.field, c.was, c.now]).slice(0, 1), [["expectedExtraKids", "5", "2"]]);
    assert.deepEqual(fetchChangesOf({ fill: {}, review: reviewOf(emptyProposal()) }, { ...FORM, expectedExtraKids: 5, socksArrangement: "guests" }), []);
  });

  await check("theEditorFeedsAndTakesThem", () => {
    const editor = code("client/src/components/beo/beo-event-editor.tsx");
    const form = editor.slice(editor.indexOf("const fetchFormValues = (): FetchFormValues => ({"), editor.indexOf("const readChatForFetch"));
    for (const piece of [
      "kitchenNotes,",
      'expectedExtraKids: typeof eventData.expectedExtraKids === "number" ? eventData.expectedExtraKids : null,',
      'expectedExtraAdults: typeof eventData.expectedExtraAdults === "number" ? eventData.expectedExtraAdults : null,',
      'socksArrangement: typeof eventData.socksArrangement === "string" ? eventData.socksArrangement : "",',
      'socksNote: typeof eventData.socksNote === "string" ? eventData.socksNote : null,',
    ]) {
      assert.ok(form.includes(piece), `the fetch reads ${piece}`);
    }
    const take = editor.slice(editor.indexOf("const applyFetched = "), editor.indexOf("useEffect(", editor.indexOf("const applyFetched = ")));
    assert.match(take, /kitchenNotes: kitchenNote,/);
    assert.match(take, /if \(kitchenNote !== undefined\) setKitchenNotes\(kitchenNote\);/);
    // The extra guests and the socks are the event's: they go with the rest of it, as any edit.
    assert.match(take, /if \(Object\.keys\(event\)\.length > 0\) setEventData\(\(prev\) => \(\{ \.\.\.prev, \.\.\.event \}\)\);/);
    // The approval writes the four columns on a party alone, the note with "Other / Custom" alone.
    const approval = code("server/lib/beoAiApprove.ts");
    assert.match(approval, /if \(isTillPartyEventType\(ev\?\.eventType\)\) \{/);
    assert.match(approval, /if \(socks !== "other"\) eventUpdates\.socksNote = null;/);
    // Nothing of them reaches the till: the platform's sources never name them (beo-guests-socks.check
    // holds that), and the approval sends them nowhere but the event's own row.
    assert.equal(/syncApprovedBeoAdditions\([^)]*socks/i.test(code("server/ai-routes.ts")), false);
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_timeline_items where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from beo_kitchen_plans where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from users where id = $1", [manager]).catch(() => undefined);
  await q("delete from branches where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from tenants where id = $1", [tenant]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== CHECKS ? 1 : 0);
