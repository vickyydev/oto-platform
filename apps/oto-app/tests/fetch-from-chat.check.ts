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
//     whose cake only when said; "no cake" never over a cake;
//   - a declined change is held back on the same chat and offered again once
//     the chat's newest line moves; the accepted ones are a patch of the form.
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
const {
  applyFetchChanges,
  changeKey,
  changesCount,
  fetchChangesOf,
  nothingNewLine,
  NO_DECLINED,
  offeredChanges,
  rememberDeclined,
} = await import("../client/src/lib/beo-fetch-from-chat");
type FetchFormValues = import("../client/src/lib/beo-fetch-from-chat").FetchFormValues;
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type ActivityLogInput = import("../server/storage").ActivityLogInput;
type BeoCatalogue = import("../server/lib/beoCatalogueFill").BeoCatalogue;

const results: Record<string, boolean> = {};
const failures: Record<string, string> = {};
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
const inbox = new Map<string, InboxRead>([
  [conv.chat, { ok: true, confirmation: { conversationId: conv.chat, eventId: ev.chat, message, scanned: 4, transcript: LINES, transcriptCut: false } }],
  // A platform older than SCRUM-815: no transcript.
  [conv.bare, { ok: true, confirmation: { conversationId: conv.bare, eventId: ev.bare, message: { ...message, id: lineIds[1]! }, scanned: 1 } as never }],
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
    if (call.system.includes("THE CONVERSATION")) return JSON.stringify(CONVERSATION_ANSWER);
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
    return key ? { id: eventId, tenantId: tenant, branchId: park, title: "ZZ TEST Emma 826", inboxConversationId: conv[key] } : null;
  },
  teamCandidates: async () => ({ employees: [], departments: [], hostSource: "employee" as const }),
  recordActivity: async (entry) => {
    activity.push(entry);
    return undefined;
  },
  inboxConfirmation: async (_req, conversationId) => inbox.get(conversationId) ?? { ok: false, reason: "inbox_unreachable" },
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

/** The form as a person left it: 5 adults typed over the booked 4, the rest as booked. */
const FORM: FetchFormValues = {
  title: "ZZ TEST Emma 826",
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
    assert.deepEqual(r.body.review.proposal.event.numAdults, { value: 6, from: { source: "team", at: at(3), line: 4 } }, "the whole chat: the later line wins the adults");
    assert.deepEqual(r.body.review.proposal.cake, { mode: null, notes: null, time: "16:00", from: { source: "team", at: at(3), line: 4 } });
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

  await check("a declined change is held back on the same chat and offered again once its newest line moves; the memory unions on one chat", () => {
    const changes = fetchChangesOf({ fill: fetched.fill, review: fetched.review }, FORM);
    const mark = fetched.chat.newestMessageId as string;
    const declined = rememberDeclined(NO_DECLINED, mark, [changes[0]!]);
    assert.deepEqual(declined, { chatMark: mark, keys: ["numAdults=6"] });
    const held = offeredChanges(changes, declined, mark);
    assert.deepEqual(held.offered.map(changeKey), ["cakeTime=16:00"]);
    assert.equal(held.held, 1);
    const moved = offeredChanges(changes, declined, randomUUID());
    assert.equal(moved.offered.length, 2, "the chat changed: offered again");
    assert.equal(moved.held, 0);
    const more = rememberDeclined(declined, mark, changes);
    assert.deepEqual(more.keys, ["numAdults=6", "cakeTime=16:00"]);
    const fresh = rememberDeclined(more, "another-line", [changes[1]!]);
    assert.deepEqual(fresh, { chatMark: "another-line", keys: ["cakeTime=16:00"] }, "a new chat starts its own memory");
    // A different value for the same field is a different change.
    assert.equal(offeredChanges([{ ...changes[0]!, value: 7, now: "7" }], declined, mark).offered.length, 1);
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
        ["title", "ZZ TEST Emma 826", "Emma's 7th", "Emma's 7th", null, "team"],
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
    assert.ok(!changes.some((c) => c.field === "decoration"), "the same value is no change");
    assert.ok(!changes.some((c) => c.field === "cakeTime"), "no cake time given: the form's stays");
    assert.ok(!changes.some((c) => c.field === "numAdults"), "the fill alone gives no adults here");
  });

  await check("whose cake only when the chat says: NOT_SAID and NONE never move the form's cake; a cake the form has none of takes the chat's", () => {
    const review = (mode: string | null) => ({ ...fetched.review, proposal: { ...fetched.review.proposal, cake: { mode, notes: null, time: null, from: { source: "family", at: null, line: 1 } } } });
    assert.ok(!fetchChangesOf({ fill: {}, review: review(null) }, FORM).some((c) => c.field === "cakeMode"));
    assert.ok(!fetchChangesOf({ fill: {}, review: review("NONE") }, FORM).some((c) => c.field === "cakeMode"));
    assert.ok(!fetchChangesOf({ fill: { kitchenPlan: { cakeMode: "NOT_SAID" } }, review: null }, FORM).some((c) => c.field === "cakeMode"));
    const own = fetchChangesOf({ fill: {}, review: review("INTERNAL") }, { ...FORM, numAdults: 6, cakeMode: "NONE" });
    assert.deepEqual(own.map((c) => [c.field, c.was, c.now, c.value, c.from?.source]), [["cakeMode", "No cake", "The park's cake", "INTERNAL", "family"]]);
    const over = fetchChangesOf({ fill: {}, review: review("INTERNAL") }, { ...FORM, numAdults: 6 });
    assert.deepEqual(over.map((c) => [c.field, c.was, c.now]), [["cakeMode", "The family's own cake", "The park's cake"]], "said as the park's: offered over the family's own, never applied");
  });

  await check("nothing is written by a fetch: no BEO row for the event", async () => {
    const { rows } = await appDbPool.query<{ n: string }>(
      `select (select count(*) from beo_package_snapshots where event_id = $1) + (select count(*) from beo_kitchen_plans where event_id = $1) + (select count(*) from beo_event_billing where event_id = $1) as n`,
      [ev.chat],
    );
    assert.equal(Number(rows[0]!.n), 0);
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
