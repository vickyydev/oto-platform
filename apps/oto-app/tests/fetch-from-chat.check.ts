// seed: none of its own — it mounts the app's AI routes on a bare server with
// the event, the inbox, the catalogue, the model and the activity row all
// stubbed, and needs only a database whose otoapp schema the app's migrator
// has built (two reads of empty BEO tables). Not a Playwright file.
//
// SCRUM-826 — "Fetch from chat" on the BEO form, the server's half and the
// diff it feeds (client/src/lib/beo-fetch-from-chat.ts):
//   - the open form asks the same inbox fill as Create BEO with
//     `purpose: "fetch"`: the answer carries the conversation's reading as it
//     is now (the whole chat for the counts, the cake and the deposit, a later
//     line winning; the ruling message for the form's own fields) and `chat`,
//     the chat's newest line, so declined changes can be held until it moves;
//   - the activity row names the press ("Fetch from chat read the inbox
//     conversation…", `purpose: fetch`) and carries no text; Create BEO's fill
//     still reads "AI Fill"; another purpose is refused; nothing is written;
//   - the diff: a field the chat gives differently is one row — the field,
//     what the form holds, what the chat says, whose line — a typed value is
//     OFFERED, never overwritten; a value the chat does not give changes
//     nothing and no field is ever offered emptied; the date as one row;
//     whose cake only when said, a cake the chat declines offered as none,
//     "not said" never moving it; a deposit the chat only asks for is never
//     offered as received;
//   - the catalogue section: a package, add-on, set menu or choice, food line,
//     entertainment or free line the chat names that the BEO lacks is LISTED
//     (never swallowed), to read; what the BEO holds is not;
//   - a declined change is held back BY FIELD on the same chat — whatever value
//     the chat reads for it next — and offered again once the chat's newest
//     line moves; an accepted field is let go; the accepted ones are a patch
//     of the form;
//   - SCRUM-826 (the staging proof of 11 November): the latest line wins,
//     whoever wrote it. The team confirms 5 adults and the park's cake at
//     15:30, the family later writes 6 adults and the cake at 16:00: the
//     proposal reads 6 and 16:00 from the family; "actually no cake" later:
//     the cake NONE from the family. The mirror — the family asks 6, the team
//     later confirms 5 — reads 5 from the team. The same chat read twice
//     through the route gives byte-identical proposals (the fake model is
//     deterministic: this pins the code path), so an unchanged chat reads
//     the same as the form, and a value accepted and saved is never offered
//     back.
//   - SCRUM-903: with no message of the team's confirming the party yet, a
//     fetch reads the conversation alone and offers its own requests (the
//     allergy, the decoration wish) beside its counts, each change carrying
//     the chat's words for it; every proposed value carries them too, so the
//     checks of who said a value compare it without them (`unquoted`).
//
// Run from apps/oto-app: DATABASE_URL=<migrated scratch> npx tsx tests/fetch-from-chat.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("fetch-from-chat.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-826";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "warn";

const { registerAIRoutes } = await import("../server/ai-routes");
const { pool: appDbPool } = await import("../server/db");
const { resolveCatalogueAnswer } = await import("../server/lib/beoCatalogueFill");
const {
  applyFetchChanges,
  catalogueChangesCount,
  changeKey,
  changesCount,
  fetchCatalogueChangesOf,
  fetchChangesOf,
  nothingNewLine,
  NO_DECLINED,
  offeredChanges,
  rememberDeclined,
} = await import("../client/src/lib/beo-fetch-from-chat");
type FetchFormValues = import("../client/src/lib/beo-fetch-from-chat").FetchFormValues;
type FetchHeldCatalogue = import("../client/src/lib/beo-fetch-from-chat").FetchHeldCatalogue;
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type ActivityLogInput = import("../server/storage").ActivityLogInput;
type BeoCatalogue = import("../server/lib/beoCatalogueFill").BeoCatalogue;

const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
/** SCRUM-903: a value's `from` without the chat's words (`quote`), for the checks of who said it, when and on which line. */
const unquoted = <T>(value: T): T => JSON.parse(JSON.stringify(value, (k, v) => (k === "quote" ? undefined : v)));
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results[name] = true;
  } catch (error) {
    results[name] = false;
    failures[name] = error instanceof Error ? error.message : String(error);
  }
}

// ─── The chat: booked at 12 kids and 4 adults, then the family asks for more ──

const tenant = randomUUID();
const park = randomUUID();
const user = randomUUID();
const conv = { chat: randomUUID(), bare: randomUUID() };
const ev = { chat: randomUUID(), bare: randomUUID() };
const lineIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const at = (i: number) => new Date(Date.UTC(2026, 10, 2, 7, i * 9)).toISOString();
const LINES = [
  { id: lineIds[0]!, author: "customer" as const, at: at(0), text: "Hi! A birthday for Emma on 21 November, 12 kids and 4 adults, cake at 15:30 please. FETCH-826" },
  { id: lineIds[1]!, author: "staff" as const, at: at(1), text: "Confirmed: 21 November at 14:00, Floresta package, 12 kids and 4 adults. Cake at 15:30. Deposit 5,000 THB received. FETCH-826" },
  { id: lineIds[2]!, author: "customer" as const, at: at(2), text: "Update: 6 adults now, and could the cake be at 16:00? FETCH-826" },
  { id: lineIds[3]!, author: "staff" as const, at: at(3), text: "Sure, 6 adults and the cake at 16:00. FETCH-826" },
];
const RULING = LINES[1]!;
const message = { id: RULING.id, body: RULING.text, bodyLanguage: null, authorName: "ZZ TEST Manager", sentAt: RULING.at, createdAt: RULING.at };

// ─── SCRUM-826: the proof's chat, and its mirror ──────────────────────────────
// The team confirms 5 adults and the park's cake at 15:30 (the ruling, line 3);
// the family later writes 6 adults and the cake at 16:00 (line 4), then
// "actually no cake" (line 6). The mirror: the family asks 6, the team LATER
// confirms 5. The fake model below reads these the way the prompt's one rule
// says — the latest line wins, whoever wrote it — and names each value's line;
// the route and the resolver turn the line into its author.
const proof = { conv: randomUUID(), event: randomUUID() };
const mirror = { conv: randomUUID(), event: randomUUID() };
const proofIds = [1, 2, 3, 4, 5, 6].map(() => randomUUID());
const PROOF_LINES = [
  { id: proofIds[0]!, author: "customer" as const, at: at(10), text: "Hi! A party for Emma, 21 November at 14:00, 4 adults please. PROOF-826" },
  { id: proofIds[1]!, author: "customer" as const, at: at(11), text: "now 6 adults please. PROOF-826" },
  { id: proofIds[2]!, author: "staff" as const, at: at(12), text: "Confirmed: Emma's party on 21 November at 14:00, 5 adults, the park's cake at 15:30. PROOF-826" },
  { id: proofIds[3]!, author: "customer" as const, at: at(13), text: "ok, 6 adults and the cake at 16:00. PROOF-826" },
  { id: proofIds[4]!, author: "customer" as const, at: at(14), text: "great, see you then! PROOF-826" },
  { id: proofIds[5]!, author: "customer" as const, at: at(15), text: "actually no cake, thanks. PROOF-826" },
];
const PROOF_RULING = PROOF_LINES[2]!;
/** How many of the proof's lines the chat holds at the moment: 4 at first, then all 6. */
let proofLinesHeld = 4;
const mirrorIds = [randomUUID(), randomUUID()];
const MIRROR_LINES = [
  { id: mirrorIds[0]!, author: "customer" as const, at: at(20), text: "Hi! A party for Emma, 21 November at 14:00, 6 adults please. MIRROR-826" },
  { id: mirrorIds[1]!, author: "staff" as const, at: at(21), text: "Confirmed: Emma's party on 21 November at 14:00, 5 adults. MIRROR-826" },
];
const MIRROR_RULING = MIRROR_LINES[1]!;
// SCRUM-903: only the family has written — no message of the team's confirms the party yet.
const noRuling = { conv: randomUUID(), event: randomUUID() };
const NO_RULING_LINES = [
  { id: randomUUID(), author: "customer" as const, at: at(30), text: "Hi! Mia's party on 28 November, 6 adults, no nuts, Mia is allergic. NORULING-826" },
  { id: randomUUID(), author: "customer" as const, at: at(31), text: "Could we have unicorn balloons? NORULING-826" },
];
const NO_RULING_ANSWER = {
  catalogue: {
    event: { numAdults: { value: 6, line: 1 } },
    requests: [
      { kind: "special_request", text: "no nuts, Mia is allergic", line: 1 },
      { kind: "decoration", text: "unicorn balloons", line: 2 },
    ],
  },
};
/**
 * A reader that follows the prompt's rule to the letter: for each thing the
 * conversation speaks about, the value and line of the LATEST line that
 * speaks about it, whoever wrote it. Deterministic, so two reads of the same
 * lines are the same bytes.
 */
function readLikeTheRule(lines: Array<{ text: string }>) {
  let numAdults: { value: number; line: number } | undefined;
  let cake: { mode?: string; time?: string; line: number } | undefined;
  lines.forEach((l, i) => {
    const line = i + 1;
    const adults = /(\d+) adults/.exec(l.text);
    if (adults) numAdults = { value: Number(adults[1]), line };
    if (/no cake/.test(l.text)) cake = { mode: "NONE", line };
    else {
      const time = /cake at (\d{2}:\d{2})/.exec(l.text);
      if (time) cake = { mode: /park's cake/.test(l.text) ? "INTERNAL" : cake?.mode, time: time[1], line };
    }
  });
  return { catalogue: { ...(numAdults ? { event: { numAdults } } : {}), ...(cake ? { cake } : {}) } };
}

const inbox = new Map<string, () => InboxRead>([
  [conv.chat, () => ({ ok: true, confirmation: { conversationId: conv.chat, eventId: ev.chat, message, scanned: 4, transcript: LINES, transcriptCut: false } })],
  // A platform older than SCRUM-815: no transcript.
  [conv.bare, () => ({ ok: true, confirmation: { conversationId: conv.bare, eventId: ev.bare, message: { ...message, id: lineIds[1]! }, scanned: 1 } as never })],
  // SCRUM-826: the proof's chat as it stands at the moment (4 lines, then 6), and its mirror.
  [proof.conv, () => {
    const transcript = PROOF_LINES.slice(0, proofLinesHeld);
    const ruling = { id: PROOF_RULING.id, body: PROOF_RULING.text, bodyLanguage: null, authorName: "ZZ TEST Manager", sentAt: PROOF_RULING.at, createdAt: PROOF_RULING.at };
    return { ok: true, confirmation: { conversationId: proof.conv, eventId: proof.event, message: ruling, scanned: transcript.length, transcript, transcriptCut: false } };
  }],
  [mirror.conv, () => {
    const ruling = { id: MIRROR_RULING.id, body: MIRROR_RULING.text, bodyLanguage: null, authorName: "ZZ TEST Manager", sentAt: MIRROR_RULING.at, createdAt: MIRROR_RULING.at };
    return { ok: true, confirmation: { conversationId: mirror.conv, eventId: mirror.event, message: ruling, scanned: 2, transcript: MIRROR_LINES, transcriptCut: false } };
  }],
  [noRuling.conv, () => ({ ok: true, confirmation: { conversationId: noRuling.conv, eventId: noRuling.event, message: null, scanned: 2, transcript: NO_RULING_LINES, transcriptCut: false } })],
]);

/** The ruling message read alone, the form as its baseline: the ruling's values, the rest carried forward. */
const FORM_ANSWER = {
  summary: "ZZ TEST Emma 826",
  event: { title: "ZZ TEST Emma 826", childName: "Emma", numChildren: 12, numAdults: 4, startTime: "14:00", eventDate: "2026-11-21", eventDateText: "21 November" },
  kitchenPlan: { cakeTime: "15:30" },
  partyDetails: { prepaymentReceived: 5000, depositDate: "2026-11-02" },
};
/** The whole conversation's catalogue section: the later lines win the adults and the cake time. */
const CONVERSATION_ANSWER = {
  catalogue: {
    package: null,
    event: {
      childName: { value: "Emma", line: 1, source: "family" },
      numChildren: { value: 12, line: 2, source: "team" },
      numAdults: { value: 6, line: 4, source: "team" },
      startTime: { value: "14:00", line: 2, source: "team" },
    },
    cake: { mode: "NOT_SAID", time: "16:00", line: 4, source: "team" },
    deposit: { amount: 5000, paid: true, date: "2026-11-02", line: 2, source: "team" },
  },
};

const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    if (call.system.includes("THE CONVERSATION")) {
      if (call.user.includes("PROOF-826")) return JSON.stringify(readLikeTheRule(PROOF_LINES.slice(0, proofLinesHeld)));
      if (call.user.includes("MIRROR-826")) return JSON.stringify(readLikeTheRule(MIRROR_LINES));
      if (call.user.includes("NORULING-826")) return JSON.stringify(NO_RULING_ANSWER);
      return JSON.stringify(CONVERSATION_ANSWER);
    }
    return JSON.stringify(FORM_ANSWER);
  },
};
const CATALOGUE: BeoCatalogue = {
  packages: [{ id: randomUUID(), name: "ZZ TEST Floresta", kidsIncluded: 10, adultsIncluded: 4, hours: 3, priceWeekday: 1_690_000, priceWeekend: 2_090_000, basePrice: 1_690_000, setMenuTemplateId: null, lines: [] }],
  setMenus: [],
  entertainment: [],
  food: [],
};
const activity: ActivityLogInput[] = [];

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.get("x-test-as")) return res.status(401).json({ message: "Not signed in" });
  (req as any).user = { id: user, tenantId: tenant, role: "manager" };
  (req as any).userWithAccess = { id: user, tenantId: tenant, isActive: true, role: "manager", hasAllBranchesAccess: false, allowedBranchIds: [park] };
  next();
}

const app = express();
app.use(express.json({ limit: "1mb" }));
registerAIRoutes(app, fakeAuth, {
  ai,
  now: () => new Date("2026-11-10T03:05:00Z"),
  loadEvent: async (_req, eventId) => {
    const key = (Object.keys(ev) as Array<keyof typeof ev>).find((k) => ev[k] === eventId);
    // SCRUM-827 review: the loader carries the event's type; the park's default title is a birthday's.
    if (key) return { id: eventId, tenantId: tenant, branchId: park, title: "ZZ TEST Emma 826", inboxConversationId: conv[key], eventType: "birthday" };
    if (eventId === proof.event) return { id: eventId, tenantId: tenant, branchId: park, title: "ZZ TEST Emma 826", inboxConversationId: proof.conv, eventType: "birthday" };
    if (eventId === mirror.event) return { id: eventId, tenantId: tenant, branchId: park, title: "ZZ TEST Emma 826", inboxConversationId: mirror.conv, eventType: "birthday" };
    if (eventId === noRuling.event) return { id: eventId, tenantId: tenant, branchId: park, title: "ZZ TEST Mia 903", inboxConversationId: noRuling.conv, eventType: "birthday" };
    return null;
  },
  teamCandidates: async () => ({ employees: [], departments: [], hostSource: "employee" as const }),
  recordActivity: async (entry) => {
    activity.push(entry);
    return undefined;
  },
  inboxConfirmation: async (_req, conversationId) => inbox.get(conversationId)?.() ?? { ok: false, reason: "inbox_unreachable" },
  parkPlace: async () => ({ name: "ZZ TEST Park", timeZone: "Asia/Bangkok" }),
  catalogue: async () => CATALOGUE,
});
const servers: Server[] = [];
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-test-as": "manager" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const EXISTING = { event: { title: "ZZ TEST Emma 826", numAdults: 5 }, kitchenPlan: { cakeTime: "15:30" } };
const fillOf = (eventId: string, purpose?: string) => post(`/api/events/${eventId}/beo/ai-fill/inbox`, { existingData: EXISTING, ...(purpose ? { purpose } : {}) });

/**
 * The form as a person left it: 5 adults typed over the booked 4, the rest as
 * booked. The title is the park's default for this event (the child Emma, no
 * age on the event), as a BEO created from the chat is named: a title the form
 * holds otherwise is offered the default beside it, as the review does
 * (SCRUM-827) — the title cases below say so with a form named by hand.
 */
const FORM: FetchFormValues = {
  title: "Emma's Birthday",
  childName: "Emma",
  bookingName: "ZZ TEST Olga",
  numChildren: 12,
  numAdults: 5,
  startTime: "14:00",
  endTime: "",
  eventDate: "2026-11-21",
  locationText: "",
  specialRequests: "",
  activities: "",
  decoration: "",
  setupReadyBy: "",
  setupResponsible: "",
  cakeMode: "EXTERNAL",
  cakeNotes: "",
  cakeTime: "15:30",
  prepaymentReceived: 5000,
  depositDate: "2026-11-02",
  packageName: "",
  packageNotes: "",
};

let fetched: any = null;

try {
  await check("Fetch from chat: the same inbox fill with purpose fetch — the whole chat's counts and cake, the ruling's form fields, and the chat's newest line", async () => {
    activity.length = 0;
    modelCalls.length = 0;
    const r = await fillOf(ev.chat, "fetch");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    fetched = r.body;
    assert.deepEqual(r.body.chat, { newestMessageId: lineIds[3], lines: 4 });
    assert.equal(r.body.source.messageId, RULING.id, "the ruling message is still the team's confirmation");
    assert.equal(r.body.fill.event.numAdults, 4, "the form's own read is the ruling message's");
    assert.deepEqual(unquoted(r.body.review.proposal.event.numAdults), { value: 6, from: { source: "team", at: at(3), line: 4 } }, "the whole chat: the later line wins the adults");
    assert.deepEqual(unquoted(r.body.review.proposal.cake), { mode: null, notes: null, time: "16:00", from: { source: "team", at: at(3), line: 4 } });
    assert.equal(r.body.review.proposal.event.numAdults.from.quote, LINES[3]!.text, "SCRUM-903: with the chat's words for it");
    assert.equal(modelCalls.length, 2, "the form's read and the conversation's");
    assert.ok(modelCalls.some((c) => c.user.includes("#4 [team]") && c.user.includes("#2 [team, RULING]")), "the conversation as it is now, the ruling marked");
    assert.ok(modelCalls.some((c) => c.user.includes('"numAdults": 5')), "the form as it stands is the baseline");
  });

  await check("the activity row names the press — Fetch from chat — with purpose fetch, no text; Create BEO's fill still reads AI Fill", async () => {
    assert.equal(activity.length, 1);
    const row = activity[0]!;
    assert.equal(row.activityType, "beo_ai_fill");
    assert.equal(row.summaryText, 'Fetch from chat read the inbox conversation for the BEO of "ZZ TEST Emma 826"');
    const meta = JSON.parse(row.metadataJson ?? "{}");
    assert.equal(meta.purpose, "fetch");
    assert.equal(meta.source, "inbox");
    assert.equal(meta.eventId, ev.chat);
    assert.ok(!(row.metadataJson ?? "").includes("FETCH-826") && !row.summaryText.includes("FETCH-826"), "no text of the chat in the row");
    activity.length = 0;
    const r = await fillOf(ev.chat);
    assert.equal(r.status, 200);
    assert.equal(activity[0]!.summaryText, 'AI Fill read the inbox conversation for the BEO of "ZZ TEST Emma 826"');
    assert.equal(JSON.parse(activity[0]!.metadataJson ?? "{}").purpose, "fill");
    assert.deepEqual(r.body.chat, { newestMessageId: lineIds[3], lines: 4 }, "the chat mark rides the fill too");
  });

  await check("another purpose is refused; a platform with no transcript marks the ruling message as the chat's line", async () => {
    const bad = await fillOf(ev.chat, "refresh");
    assert.equal(bad.status, 400);
    const bare = await fillOf(ev.bare, "fetch");
    assert.equal(bare.status, 200, JSON.stringify(bare.body));
    assert.deepEqual(bare.body.chat, { newestMessageId: lineIds[1], lines: 1 });
  });

  await check("the diff: adults 5 (typed) → 6 and cake time 15:30 → 16:00, each the team's; the typed value is offered, never overwritten; nothing else moves", () => {
    const changes = fetchChangesOf({ fill: fetched.fill, review: fetched.review }, FORM);
    assert.deepEqual(
      changes.map((c) => [c.field, c.label, c.was, c.now, c.value, c.from?.source, c.from?.line]),
      [
        ["numAdults", "Adults", "5", "6", 6, "team", 4],
        ["cakeTime", "Cake time", "15:30", "16:00", "16:00", "team", 4],
      ],
    );
    assert.equal(changesCount(changes.length), "2 changes from the chat");
    assert.equal(changesCount(1), "1 change from the chat");
    assert.deepEqual(applyFetchChanges(changes), { numAdults: 6, cakeTime: "16:00" });
    assert.deepEqual(applyFetchChanges([changes[1]!]), { cakeTime: "16:00" }, "only the accepted ones");
    // The chat's values already in the form: nothing is offered.
    const same = fetchChangesOf({ fill: fetched.fill, review: fetched.review }, { ...FORM, numAdults: 6, cakeTime: "16:00" });
    assert.deepEqual(same, []);
    assert.equal(nothingNewLine(0), "The chat reads the same as the form.");
    assert.equal(nothingNewLine(1), "The chat reads the same as the form. 1 change you declined earlier is not offered again until the chat changes.");
    assert.equal(nothingNewLine(2), "The chat reads the same as the form. 2 changes you declined earlier are not offered again until the chat changes.");
  });

  await check("a declined FIELD is held back on the same chat, whatever value the chat reads for it, and offered again once its newest line moves; the memory unions on one chat; an accepted field is let go", () => {
    const changes = fetchChangesOf({ fill: fetched.fill, review: fetched.review }, FORM);
    const mark = fetched.chat.newestMessageId as string;
    const declined = rememberDeclined(NO_DECLINED, mark, [changes[0]!]);
    assert.deepEqual(declined, { chatMark: mark, fields: ["numAdults"] });
    const held = offeredChanges(changes, declined, mark);
    assert.deepEqual(held.offered.map(changeKey), ["cakeTime"]);
    assert.equal(held.held, 1);
    // SCRUM-826: another reading of the same field on the same chat (the proof's "Adults → 6"
    // declined, then "Adults → 5" offered) is the same held field.
    const another = offeredChanges([{ ...changes[0]!, value: 5, now: "5" }, changes[1]!], declined, mark);
    assert.deepEqual(another.offered.map(changeKey), ["cakeTime"], "a different value for a declined field slips nothing past the decline");
    assert.equal(another.held, 1);
    const moved = offeredChanges(changes, declined, randomUUID());
    assert.equal(moved.offered.length, 2, "the chat changed: offered again");
    assert.equal(moved.held, 0);
    const more = rememberDeclined(declined, mark, changes);
    assert.deepEqual(more.fields, ["numAdults", "cakeTime"]);
    const fresh = rememberDeclined(more, "another-line", [changes[1]!]);
    assert.deepEqual(fresh, { chatMark: "another-line", fields: ["cakeTime"] }, "a new chat starts its own memory");
    // An accepted field is let go of the memory; a decline and an accept on one press each count.
    assert.deepEqual(rememberDeclined(more, mark, [], [changes[0]!]), { chatMark: mark, fields: ["cakeTime"] });
    assert.deepEqual(rememberDeclined(declined, mark, [changes[1]!], [changes[0]!]), { chatMark: mark, fields: ["cakeTime"] });
    assert.deepEqual(rememberDeclined(more, "another-line", [], [changes[0]!]), { chatMark: "another-line", fields: [] }, "accepted on a new chat: nothing held");
  });

  await check("SCRUM-826: the same chat read twice through the route gives byte-identical proposals and the same chat mark; an unchanged chat reads the same as the form", async () => {
    const first = await fillOf(ev.chat, "fetch");
    const second = await fillOf(ev.chat, "fetch");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(JSON.stringify(first.body.review.proposal), JSON.stringify(second.body.review.proposal), "the proposal, byte for byte");
    assert.equal(JSON.stringify(first.body.fill), JSON.stringify(second.body.fill), "the form's read, byte for byte");
    assert.deepEqual(first.body.chat, second.body.chat);
    // The form holds what the chat says: each press says the same.
    const settled = { ...FORM, numAdults: 6, cakeTime: "16:00" };
    assert.deepEqual(fetchChangesOf({ fill: first.body.fill, review: first.body.review }, settled), []);
    assert.deepEqual(fetchChangesOf({ fill: second.body.fill, review: second.body.review }, settled), []);
  });

  await check("SCRUM-826: the team confirms 5 adults and the park's cake at 15:30, the family later writes 6 adults and the cake at 16:00 — the family's 6 and 16:00 win; the saved 16:00 is never offered back as 15:30", async () => {
    proofLinesHeld = 4;
    const r = await fillOf(proof.event, "fetch");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.chat, { newestMessageId: proofIds[3], lines: 4 });
    assert.equal(r.body.source.messageId, PROOF_RULING.id, "the ruling message is still the team's confirmation");
    const p = r.body.review.proposal;
    assert.deepEqual(unquoted(p.event.numAdults), { value: 6, from: { source: "family", at: at(13), line: 4 } }, "the adults: the family's line after the confirmation");
    assert.deepEqual(unquoted(p.cake), { mode: "INTERNAL", notes: null, time: "16:00", from: { source: "family", at: at(13), line: 4 } }, "the cake: the park's, at the family's later time");
    assert.ok(modelCalls.at(-2)!.system.includes("The latest line wins, whoever wrote it") || modelCalls.at(-1)!.system.includes("The latest line wins, whoever wrote it"), "the conversation's prompt states the one rule");

    // The form as the proof left it: 7 adults typed (unsaved), the park's cake at 15:30 from the approval.
    const typed = { ...FORM, numAdults: 7, cakeMode: "INTERNAL", cakeTime: "15:30" };
    const changes = fetchChangesOf({ fill: r.body.fill, review: r.body.review }, typed);
    assert.deepEqual(
      changes.map((c) => [c.field, c.was, c.now, c.value, c.from?.source, c.from?.line]),
      [
        ["numAdults", "7", "6", 6, "family", 4],
        ["cakeTime", "15:30", "16:00", "16:00", "family", 4],
      ],
    );
    // Cake time accepted and saved, the adults declined: the next press on the same chat
    // offers nothing — not the adults (held by field) and never "16:00 → 15:30".
    const declined = rememberDeclined(NO_DECLINED, r.body.chat.newestMessageId, [changes[0]!], [changes[1]!]);
    assert.deepEqual(declined, { chatMark: proofIds[3], fields: ["numAdults"] });
    const again = await fillOf(proof.event, "fetch");
    assert.equal(JSON.stringify(again.body.review.proposal), JSON.stringify(p), "the same chat, the same bytes");
    const saved = { ...typed, cakeTime: "16:00" };
    const next = fetchChangesOf({ fill: again.body.fill, review: again.body.review }, saved);
    assert.deepEqual(next.map((c) => [c.field, c.now]), [["numAdults", "6"]], "only the adults differ; the saved cake time is not offered back");
    const offered = offeredChanges(next, declined, again.body.chat.newestMessageId);
    assert.deepEqual(offered, { offered: [], held: 1 });
    assert.equal(nothingNewLine(offered.held), "The chat reads the same as the form. 1 change you declined earlier is not offered again until the chat changes.");
  });

  await check("SCRUM-826: the family's \"actually no cake\" after the confirmation — the cake NONE from the family, offered as No cake over the park's, and the held adults offered again on the new line", async () => {
    proofLinesHeld = 6;
    const r = await fillOf(proof.event, "fetch");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.chat, { newestMessageId: proofIds[5], lines: 6 });
    const p = r.body.review.proposal;
    assert.deepEqual(unquoted(p.cake), { mode: "NONE", notes: null, time: null, from: { source: "family", at: at(15), line: 6 } }, "no cake: the family's latest line");
    assert.deepEqual(unquoted(p.event.numAdults), { value: 6, from: { source: "family", at: at(13), line: 4 } }, "the adults as before: no later line changed them");
    const saved = { ...FORM, numAdults: 7, cakeMode: "INTERNAL", cakeTime: "16:00" };
    const changes = fetchChangesOf({ fill: r.body.fill, review: r.body.review }, saved);
    assert.deepEqual(
      changes.map((c) => [c.field, c.was, c.now, c.value, c.from?.source, c.from?.line]),
      [
        ["numAdults", "7", "6", 6, "family", 4],
        ["cakeMode", "The park's cake", "No cake", "NONE", "family", 6],
      ],
      "the no-cake row on the FIRST press after the line, and no cake time row",
    );
    // The adults were held on the 4-line chat: the chat has a new line, so they are offered again.
    const held = { chatMark: proofIds[3]!, fields: ["numAdults" as const] };
    assert.deepEqual(offeredChanges(changes, held, r.body.chat.newestMessageId), { offered: changes, held: 0 });
  });

  await check("SCRUM-826, the mirror: the family asks for 6 adults, the team LATER confirms 5 — 5 from the team", async () => {
    const r = await fillOf(mirror.event, "fetch");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.chat, { newestMessageId: mirrorIds[1], lines: 2 });
    assert.equal(r.body.source.messageId, MIRROR_RULING.id);
    assert.deepEqual(unquoted(r.body.review.proposal.event.numAdults), { value: 5, from: { source: "team", at: at(21), line: 2 } });
    assert.equal(r.body.review.proposal.cake, null, "no cake spoken of");
    const changes = fetchChangesOf({ fill: r.body.fill, review: r.body.review }, { ...FORM, numAdults: 6 });
    assert.deepEqual(changes.map((c) => [c.field, c.was, c.now, c.from?.source, c.from?.line]), [["numAdults", "6", "5", "team", 2]]);
  });

  await check("the fields the fill alone gives: the date as one row with the chat's words, the form's text fields, the setup, the POS box; a value the chat does not give leaves the field; nothing is offered emptied", () => {
    const fill = {
      event: { title: "Emma's 7th", bookingName: "", locationText: "Jungle Room", specialRequests: "no nuts", activities: "", decoration: "balloons", eventDate: "2026-11-28", eventDateText: "the 28th", endTime: "17.00" },
      setupPlan: { readyBy: "13:30", responsible: "Ying" },
      kitchenPlan: { cakeMode: "internal", cakeNotes: "ice-cream cake", cakeTime: "" },
      partyDetails: { packageName: "Floresta", notes: "pay the rest on the day", prepaymentReceived: "6,000", depositDate: "2026-11-05" },
    };
    const changes = fetchChangesOf({ fill, review: null }, { ...FORM, bookingName: "ZZ TEST Olga", decoration: "balloons", numAdults: 4 });
    assert.deepEqual(
      changes.map((c) => [c.field, c.was, c.now, c.value, c.said, c.from?.source]),
      [
        ["eventDate", "Sat 21 Nov 2026", "Sat 28 Nov 2026", "2026-11-28", "the 28th", "team"],
        ["endTime", "—", "17:00", "17:00", null, "team"],
        ["locationText", "—", "Jungle Room", "Jungle Room", null, "team"],
        ["specialRequests", "—", "no nuts", "no nuts", null, "team"],
        ["setupReadyBy", "—", "13:30", "13:30", null, "team"],
        ["setupResponsible", "—", "Ying", "Ying", null, "team"],
        ["cakeMode", "The family's own cake", "The park's cake", "INTERNAL", null, "team"],
        ["cakeNotes", "—", "ice-cream cake", "ice-cream cake", null, "team"],
        ["packageName", "—", "Floresta", "Floresta", null, "team"],
        ["prepaymentReceived", "฿5,000", "฿6,000", 6000, null, "team"],
        ["depositDate", "Mon 2 Nov 2026", "Thu 5 Nov 2026", "2026-11-05", null, "team"],
        ["packageNotes", "—", "pay the rest on the day", "pay the rest on the day", null, "team"],
      ],
    );
    assert.ok(!changes.some((c) => c.field === "bookingName"), "an empty value never empties a field");
    assert.ok(!changes.some((c) => c.field === "title"), "SCRUM-827: the fill's title is the model's own guess, never offered");
    // The title a fetch offers is the park's default the proposal carries (the app's naming rule), marked as such, only where it differs.
    const titled = (title: { value: string; from: { source: "default"; at: null; line: null } } | null) => ({
      ...fetched.review,
      proposal: { ...fetched.review.proposal, details: { ...fetched.review.proposal.details, title } },
    });
    const named = { ...FORM, title: "ZZ TEST Emma 826" };
    const byDefault = fetchChangesOf({ fill, review: titled({ value: "Emma's 7th Birthday", from: { source: "default", at: null, line: null } }) }, named).find((c) => c.field === "title");
    assert.deepEqual(byDefault && [byDefault.was, byDefault.now, byDefault.value, byDefault.from?.source], ["ZZ TEST Emma 826", "Emma's 7th Birthday", "Emma's 7th Birthday", "default"]);
    assert.ok(!fetchChangesOf({ fill, review: titled({ value: "ZZ TEST Emma 826", from: { source: "default", at: null, line: null } }) }, named).some((c) => c.field === "title"), "the form's own name already: nothing offered");
    assert.ok(!fetchChangesOf({ fill, review: titled(null) }, named).some((c) => c.field === "title"), "no default (no child's name): nothing, never the model's");
    // The route's own default for this event, against a form named by hand: the one title row, the park's default.
    const routed = fetchChangesOf({ fill: fetched.fill, review: fetched.review }, { ...named, numAdults: 6, cakeTime: "16:00" });
    assert.deepEqual(routed.map((c) => [c.field, c.was, c.now, c.from?.source, c.from?.line]), [["title", "ZZ TEST Emma 826", "Emma's Birthday", "default", null]]);
    assert.ok(!changes.some((c) => c.field === "decoration"), "the same value is no change");
    assert.ok(!changes.some((c) => c.field === "cakeTime"), "no cake time given: the form's stays");
    assert.ok(!changes.some((c) => c.field === "numAdults"), "the fill alone gives no adults here");
  });

  await check("whose cake only when the chat says: NOT_SAID never moves the form's cake; a cake the chat declines (NONE) is offered as No cake over it, whose line said it; a cake the form has none of takes the chat's", () => {
    const review = (mode: string | null, notes: string | null = null, time: string | null = null) => ({
      ...fetched.review,
      proposal: { ...fetched.review.proposal, cake: { mode, notes, time, from: { source: "family", at: null, line: 1 } } },
    });
    assert.ok(!fetchChangesOf({ fill: {}, review: review(null) }, FORM).some((c) => c.field === "cakeMode"), "not said: the form's cake stays");
    assert.ok(!fetchChangesOf({ fill: { kitchenPlan: { cakeMode: "NOT_SAID" } }, review: null }, FORM).some((c) => c.field === "cakeMode"));
    // The chat said there is no cake: one row, the form's cake → No cake, the family's line; the chat's words are no cake notes and a declined cake has no time.
    const declined = fetchChangesOf({ fill: {}, review: review("NONE", "no cake, thanks", "16:00") }, { ...FORM, numAdults: 6 });
    assert.deepEqual(
      declined.map((c) => [c.field, c.label, c.was, c.now, c.value, c.from?.source, c.from?.line]),
      [["cakeMode", "Cake", "The family's own cake", "No cake", "NONE", "family", 1]],
      "the chat declined the cake: offered as none over the family's own cake, nothing else of the cake",
    );
    assert.deepEqual(applyFetchChanges(declined), { cakeMode: "NONE" }, "accepted, the form says No Cake as its own button does");
    assert.ok(!fetchChangesOf({ fill: {}, review: review("NONE") }, { ...FORM, cakeMode: "NONE" }).some((c) => c.field === "cakeMode"), "no cake on both sides: no row");
    assert.ok(!fetchChangesOf({ fill: { kitchenPlan: { cakeMode: "NONE" } }, review: null }, FORM).some((c) => c.field === "cakeMode"), "the fill alone (no catalogue) reads NONE as AI Fill does: nothing to apply");
    const own = fetchChangesOf({ fill: {}, review: review("INTERNAL") }, { ...FORM, numAdults: 6, cakeMode: "NONE" });
    assert.deepEqual(own.map((c) => [c.field, c.was, c.now, c.value, c.from?.source]), [["cakeMode", "No cake", "The park's cake", "INTERNAL", "family"]]);
    const over = fetchChangesOf({ fill: {}, review: review("INTERNAL") }, { ...FORM, numAdults: 6 });
    assert.deepEqual(over.map((c) => [c.field, c.was, c.now]), [["cakeMode", "The family's own cake", "The park's cake"]], "said as the park's: offered over the family's own, never applied");
  });

  await check("a deposit the chat only asks for is never offered as received: paid false offers no deposit row, not even its date; paid true does", () => {
    const review = (paid: boolean) => ({ ...fetched.review, proposal: { ...fetched.review.proposal, deposit: { amount: 5000, paid, date: "2026-11-05", from: { source: "team", at: null, line: 2 } } } });
    const form = { ...FORM, numAdults: 6, cakeTime: "16:00", prepaymentReceived: 0, depositDate: "" };
    const asked = fetchChangesOf({ fill: { partyDetails: { prepaymentReceived: 5000, depositDate: "2026-11-05" } }, review: review(false) }, form);
    assert.deepEqual(asked, [], "asked for, not received: nothing from the whole chat's read, nor from the fill's");
    const received = fetchChangesOf({ fill: {}, review: review(true) }, form);
    assert.deepEqual(
      received.map((c) => [c.field, c.was, c.now, c.value]),
      [
        ["prepaymentReceived", "—", "฿5,000", 5000],
        ["depositDate", "—", "Thu 5 Nov 2026", "2026-11-05"],
      ],
    );
    // A chat that names no deposit at all: the fill's prepayment (received by name) still counts.
    const fillOnly = fetchChangesOf({ fill: { partyDetails: { prepaymentReceived: 5000 } }, review: { ...fetched.review, proposal: { ...fetched.review.proposal, deposit: null } } }, form);
    assert.deepEqual(fillOnly.map((c) => c.field), ["prepaymentReceived"]);
  });

  await check("the catalogue section: a package, add-on, set menu, choice, food line, entertainment and free line the chat names that the BEO lacks are listed, never swallowed; what it holds is not", () => {
    const pkg = CATALOGUE.packages[0]!;
    const addOn = "a1a1a1a1-0000-4000-8000-000000000001";
    const setMenu = "b2b2b2b2-0000-4000-8000-000000000002";
    const group = "c3c3c3c3-0000-4000-8000-000000000003";
    const magician = "d4d4d4d4-0000-4000-8000-000000000004";
    const family = { source: "family" as const, at: null, line: 3 };
    const team = { source: "team" as const, at: null, line: 4 };
    const review: BeoAiReview = {
      ...fetched.review,
      catalogue: {
        packages: [{ ...pkg, lines: [{ id: addOn, label: "Extra hour", category: "time", included: false, qtyDefault: 1, unitLabel: null, unitPrice: 150000, priceIsFrom: false }] }],
        setMenus: [{ id: setMenu, name: "ZZ TEST Kids set", items: [{ id: group, type: "choice_group", label: "Main", options: ["Chicken nuggets", "Fish fingers"], allowMultiple: false, productCode: null, optionProductCodes: {}, qty: null }] }],
        entertainment: [{ id: magician, name: "ZZ TEST Magician", category: null, durationMinutes: 30, price: 350000, unit: null, priceIsFrom: false }],
        food: [{ code: "PZ-MARG", names: ["Margherita"] }],
      },
      proposal: {
        ...fetched.review.proposal,
        package: { templateId: pkg.id, said: "Floresta", chatPrice: null, from: team },
        addOns: [{ lineId: addOn, quantity: 1, said: "one more hour", chatPrice: null, from: family }],
        setMenu: { templateId: setMenu, from: team, choices: [{ itemId: group, option: "Fish fingers", said: "fish fingers please", from: family }] },
        menuLines: [
          { menu: "adults", itemName: "margherita pizza", quantity: 2, productCode: "PZ-MARG", matchedName: "Margherita", notInMenu: false, chatPrice: null, from: family },
          { menu: "bar", itemName: "Som tam", quantity: 3, productCode: null, matchedName: null, notInMenu: true, chatPrice: null, from: family },
        ],
        entertainment: [{ templateId: magician, name: "ZZ TEST Magician", said: "a magician", quantity: 1, chatPrice: null, notInCatalogue: false, from: team }],
        otherLines: [{ text: "a piñata", chatPrice: null, from: family }],
      },
    };
    const none: FetchHeldCatalogue = { package: null, packageItems: [], setMenuTemplateId: null, menuLines: [], entertainment: [] };
    const listed = fetchCatalogueChangesOf(review, none, FORM);
    assert.deepEqual(
      listed.map((c) => [c.section, c.label, c.was, c.now, c.from?.source]),
      [
        ["package", "Package", "—", "ZZ TEST Floresta", "team"],
        ["addOn", "Add-on", "—", "Extra hour", "family"],
        ["setMenu", "Set menu", "—", "ZZ TEST Kids set", "team"],
        ["choice", "Set menu · Main", "—", "Fish fingers", "family"],
        ["food", "Adults menu", "—", "Margherita × 2", "family"],
        ["food", "Bar", "—", "Som tam × 3 (not on the menu)", "family"],
        ["entertainment", "Entertainment", "—", "ZZ TEST Magician", "team"],
        ["other", "Also asked", "—", "a piñata", "family"],
      ],
    );
    assert.equal(catalogueChangesCount(listed.length), "8 changes to the package, menu or entertainment");
    assert.equal(catalogueChangesCount(1), "1 change to the package, menu or entertainment");
    // The BEO holds all of it (as an approval left it): nothing is listed.
    const all: FetchHeldCatalogue = {
      package: { templateId: pkg.id, name: "ZZ TEST Floresta" },
      packageItems: ["Extra hour"],
      setMenuTemplateId: setMenu,
      menuLines: [
        { itemName: "Fish fingers", quantity: 1, productCode: null, groupId: group },
        { itemName: "Margherita", quantity: 2, productCode: "pz-marg", groupId: null },
        { itemName: "som tam", quantity: 3, productCode: null, groupId: null },
      ],
      entertainment: [{ templateId: magician, name: "ZZ TEST Magician" }],
    };
    assert.deepEqual(fetchCatalogueChangesOf(review, all, { specialRequests: "No nuts.\na piñata" }), []);
    // The BEO holds another package, another set menu, the other choice and the pizza at another quantity: each a row with what it holds.
    const other: FetchHeldCatalogue = {
      ...all,
      package: { templateId: randomUUID(), name: "ZZ TEST Jungle" },
      packageItems: [],
      setMenuTemplateId: randomUUID(),
      menuLines: [
        { itemName: "Chicken nuggets", quantity: 1, productCode: null, groupId: group },
        { itemName: "Margherita", quantity: 1, productCode: "PZ-MARG", groupId: null },
        { itemName: "Som tam", quantity: 3, productCode: null, groupId: null },
      ],
    };
    assert.deepEqual(
      fetchCatalogueChangesOf(review, other, { specialRequests: "a piñata" }).map((c) => [c.section, c.was, c.now]),
      [
        ["package", "ZZ TEST Jungle", "ZZ TEST Floresta"],
        ["addOn", "—", "Extra hour"],
        ["setMenu", "another set menu", "ZZ TEST Kids set"],
        ["choice", "Chicken nuggets", "Fish fingers"],
        ["food", "Margherita", "Margherita × 2"],
      ],
    );
    // No catalogue read (an older platform, no review): nothing to list; the whole chat's own proposal names nothing: nothing either.
    assert.deepEqual(fetchCatalogueChangesOf(null, none, FORM), []);
    assert.deepEqual(fetchCatalogueChangesOf(fetched.review, none, FORM), []);
  });

  await check("SCRUM-903: no team confirmation yet — the conversation read alone, its own requests offered beside its counts, each change with the chat's words", async () => {
    const before = modelCalls.length;
    const r = await fillOf(noRuling.event, "fetch");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(modelCalls.length, before + 1, "the conversation's read alone");
    assert.equal(r.body.source, null, "no ruling message");
    assert.equal(r.body.review.ruling, null);
    assert.deepEqual(r.body.chat, { newestMessageId: NO_RULING_LINES[1]!.id, lines: 2 });
    const changes = fetchChangesOf({ fill: r.body.fill, review: r.body.review }, { ...FORM, title: "ZZ TEST Mia 903", childName: "Mia" });
    assert.deepEqual(
      changes.map((c) => [c.field, c.was, c.now, c.from?.source, c.from?.line, c.from?.quote]),
      [
        ["numAdults", "5", "6", "family", 1, NO_RULING_LINES[0]!.text],
        ["specialRequests", "—", "no nuts, Mia is allergic", "family", 1, "no nuts, Mia is allergic"],
        ["decoration", "—", "unicorn balloons", "family", 2, "unicorn balloons"],
      ],
      "the family's adults, allergy and decoration, each with their words",
    );
    // With a ruling, the text fields stay the ruling message's (the fill's), as before.
    const ruled = fetchChangesOf({ fill: {}, review: { ...r.body.review, ruling: { source: "team", at: null, line: null } } }, { ...FORM, title: "ZZ TEST Mia 903", childName: "Mia" });
    assert.deepEqual(ruled.map((c) => c.field), ["numAdults"], "a review with a ruling takes no text field from the conversation's requests");
    // The activity row names the press and carries none of the chat's words.
    const row = activity.at(-1)!;
    assert.ok(row.summaryText.startsWith("Fetch from chat read the inbox conversation"));
    for (const words of ["NORULING-826", "no nuts", "unicorn"]) assert.ok(!(row.summaryText + row.metadataJson).includes(words), `no "${words}" in the activity row`);
  });

  // SCRUM-958 (SCRUM-946's open point, the 12 November proof): straight after an approval a fetch
  // offered "chicken fried rice for the adults → Fried rice (CF-43), Till 240" while the BEO held the
  // set menu's Fried rice: Chicken, a line named "Chicken". Compared by the set menu's group and
  // option and the till code, on the kids' list and the adults', it is held.
  await check("SCRUM-958: a set-menu dish the BEO holds under its option's name is not offered again; another option or an extra order still is", () => {
    const setMenu = "e5e5e5e5-0000-4000-8000-000000000005";
    const RICE = "item_958_fried_rice";
    const PIZZA = "item_958_pizza";
    const family = { source: "family" as const, at: null, line: 2 };
    const review = (menuLines: BeoAiReview["proposal"]["menuLines"]): BeoAiReview => ({
      ...fetched.review,
      catalogue: {
        packages: [],
        setMenus: [{
          id: setMenu, name: "ZZ TEST Birthday set menu",
          items: [
            { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian"], allowMultiple: false, productCode: null, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27" }, qty: null },
            { id: RICE, type: "choice_group", label: "Fried rice", options: ["Veggie", "Chicken", "Shrimp"], allowMultiple: false, productCode: "CF-43", optionProductCodes: {}, qty: null },
          ],
        }],
        entertainment: [],
        food: [{ code: "CF-24", names: ["Margherita"] }, { code: "CF-43", names: ["Fried rice (Veggie)", "Fried rice (Chicken)", "Fried rice (Shrimp)"] }],
        till: [{ code: "CF-24", name: "Margherita", category: "Pizza", station: "kitchen", priceSatang: 40000 }, { code: "CF-43", name: "Fried rice", category: "Asian Food", station: "kitchen", priceSatang: 24000 }],
      },
      proposal: { ...fetched.review.proposal, package: null, addOns: [], setMenu: { templateId: setMenu, from: family, choices: [] }, menuLines, entertainment: [], otherLines: [] },
    });
    const line = (over: Partial<BeoAiReview["proposal"]["menuLines"][number]>): BeoAiReview["proposal"]["menuLines"][number] => ({
      menu: "adults", itemName: "chicken fried rice for the adults", quantity: 1, productCode: "CF-43", matchedName: "Fried rice (Chicken)", notInMenu: false, chatPrice: null, from: family, ...over,
    });
    // The BEO as the approval of before left it: the kids' set menu holds Fried rice: Chicken.
    const kidsHeld: FetchHeldCatalogue = {
      package: null, packageItems: [], setMenuTemplateId: setMenu, entertainment: [],
      menuLines: [{ itemName: "Hawaiian", quantity: 1, productCode: null, groupId: PIZZA }, { itemName: "Chicken", quantity: 1, productCode: null, groupId: RICE }],
    };
    const food = (r: BeoAiReview, h: FetchHeldCatalogue) => fetchCatalogueChangesOf(r, h, FORM).filter((c) => c.section === "food").map((c) => c.now);
    assert.deepEqual(food(review([line({})]), kidsHeld), [], "the proof's case: held as Chicken of Fried rice");
    assert.deepEqual(food(review([line({ matchedName: "Fried rice" })]), kidsHeld), [], "no option told: the group's dish is held");
    // The BEO as this rule writes it: the adults' own SET line of the dish, on the adults' list.
    const adultsHeld: FetchHeldCatalogue = {
      ...kidsHeld,
      menuLines: [{ itemName: "Hawaiian", quantity: 1, productCode: null, groupId: PIZZA }, { itemName: "Hawaiian", quantity: 1, productCode: null, groupId: PIZZA }, { itemName: "Chicken", quantity: 1, productCode: null, groupId: RICE }],
    };
    assert.deepEqual(food(review([line({ setMenuItemId: RICE })]), adultsHeld), [], "the adults' SET line, held on their list");
    // Another option than the one held is offered.
    assert.equal(food(review([line({ itemName: "shrimp fried rice for the adults", matchedName: "Fried rice (Shrimp)", setMenuItemId: RICE })]), adultsHeld).length, 1);
    // An extra order of a set-menu dish is no set-menu dish: compared by name and quantity, as before.
    const extra = line({ itemName: "3 more Margherita pizzas for the adults", quantity: 3, productCode: "CF-24", matchedName: "Margherita" });
    assert.equal(food(review([extra]), { ...kidsHeld, menuLines: [{ itemName: "Margherita", quantity: 1, productCode: null, groupId: PIZZA }] }).length, 1, "the 3 more are offered beside the set menu's one");
    assert.deepEqual(food(review([extra]), { ...kidsHeld, menuLines: [{ itemName: "Margherita", quantity: 1, productCode: null, groupId: PIZZA }, { itemName: "Margherita", quantity: 3, productCode: "CF-24", groupId: null }] }), [], "held as the adults' extra: not offered");
    // A BEO with no such dish: offered.
    assert.equal(food(review([line({})]), { ...kidsHeld, menuLines: [] }).length, 1);
    // The lane's reviews: a new order of the family's own of a set-menu dish is offered, beside the
    // set menu's Margherita the BEO holds: a count that is not the table's own, or a word asking for
    // more outside the model's words for the dish. The chat's lines, read as the fill reads them.
    const margheritaHeld: FetchHeldCatalogue = { ...kidsHeld, menuLines: [{ itemName: "Margherita", quantity: 1, productCode: null, groupId: PIZZA }] };
    const chat = ["A party for 12 kids and 8 adults, the Margherita pizza for the kids.", "On top of that one Margherita pizza for the adults please, and can we add 2 Margherita pizzas on the side for the kids?"];
    const read = resolveCatalogueAnswer(
      {
        setMenu: { templateId: setMenu, line: 1, choices: [{ itemId: PIZZA, option: "Margherita", said: "the Margherita pizza for the kids", line: 1 }] },
        menuLines: [
          { productCode: "CF-24", itemName: "one Margherita pizza", menu: "adults", quantity: 1, line: 2 },
          { productCode: "CF-24", itemName: "2 Margherita pizzas on the side", menu: "kids", quantity: 2, line: 2 },
        ],
        event: { numChildren: { value: 12, line: 1 }, numAdults: { value: 8, line: 1 } },
      },
      review([]).catalogue,
      chat.map((text, i) => ({ line: i + 1, id: `958-${i}`, source: "family" as const, at: new Date(Date.UTC(2026, 10, 12, 15, i)).toISOString(), ruling: false, text })),
    );
    assert.deepEqual(read.menuLines.map((l) => [l.menu, l.quantity, l.setMenuItemId ?? null, l.ownOrder ?? null]), [["adults", 1, null, true], ["kids", 2, null, true]], "the read keeps both as orders of their own");
    const offered = fetchCatalogueChangesOf({ ...review(read.menuLines), proposal: { ...review(read.menuLines).proposal, event: read.event } }, margheritaHeld, FORM)
      .filter((c) => c.section === "food")
      .map((c) => c.label);
    assert.deepEqual(offered, ["Adults menu", "Kids menu"], "both offered");
    // And as staff would see a line in a count of its own, without the read's mark: the adults' 2, the kids' 10 (12 kids).
    const counted = [
      line({ itemName: "2 Margherita pizzas for the adults", quantity: 2, productCode: "CF-24", matchedName: "Margherita" }),
      line({ menu: "kids", itemName: "10 Margherita pizzas", quantity: 10, productCode: "CF-24", matchedName: "Margherita" }),
    ];
    assert.equal(food(review(counted), margheritaHeld).length, 2, "both offered: neither is the table's own count");
    // One for each child is the table's own order: the set menu's Margherita, held.
    assert.deepEqual(food(review([line({ menu: "kids", itemName: "Margherita pizzas", quantity: 12, productCode: "CF-24", matchedName: "Margherita" })]), margheritaHeld), []);
  });

  await check("nothing is written by a fetch: no BEO row for the event", async () => {
    for (const eventId of [ev.chat, proof.event, mirror.event, noRuling.event]) {
      const { rows } = await appDbPool.query<{ n: string }>(
        `select (select count(*) from beo_package_snapshots where event_id = $1) + (select count(*) from beo_kitchen_plans where event_id = $1) + (select count(*) from beo_event_billing where event_id = $1) as n`,
        [eventId],
      );
      assert.equal(Number(rows[0]!.n), 0);
    }
  });
} finally {
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  await appDbPool.end().catch(() => undefined);
}

const names = Object.keys(results);
const failed = names.filter((n) => !results[n]);
for (const n of names) console.log(`${results[n] ? "  ok  " : "  FAIL" } ${n}${results[n] ? "" : `\n        ${failures[n]}`}`);
console.log(`fetch-from-chat.check: ${names.length - failed.length}/${names.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
