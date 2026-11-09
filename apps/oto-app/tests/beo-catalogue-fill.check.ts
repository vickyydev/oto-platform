// seed: its own — two ZZ TEST park groups, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes and the BEO's own routes
// on a bare server (a stub model, a stub platform api) and needs a database
// whose otoapp schema the app's migrator has built. It renders the review's
// own component, so it runs with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-815 — Create BEO's AI Fill reads the WHOLE conversation and matches it
// to the park's catalogue; the review shows the proposed BEO in edit mode;
// nothing is written until staff press "Approve and create".
//   - three conversations, in Russian, Thai and English, each agreeing the
//     Floresta package, a pizza choice from its set menu, one extra dish, an
//     entertainment line, and a family-only wish the team never confirmed.
//     Two reads: the form's own fields from the ruling message alone (as
//     SCRUM-660 read them, the family's lines never in it), and the numbered
//     conversation — the ruling message marked, the conversation's rules, the
//     catalogue with its ids, the park's today last — answering only the
//     catalogue section;
//   - the proposal's ids are the catalogue's; each value's source is the
//     author of the line it came from, never the model's claim (a line the
//     transcript does not hold is the family's, a default to check); the same
//     add-on, dish, entertainment or choice named by the family and the team
//     is the team's; a dish the catalogue lacks is a notInMenu line; an id
//     the catalogue does not hold is a free line; the chat's price rides
//     beside the catalogue's;
//   - nothing is written by the fill;
//   - "Approve and create", with the body the review itself builds, writes the
//     package snapshot, the kitchen plan (set menu, choices, extra dish, free
//     line), the entertainment at the catalogue's prices, the counts, times,
//     the date when ticked, and the deposit both in billing and where the BEO
//     reads it (Party Details' prepayment), and one beo_ai_fill activity row
//     with the sources and matches and none of the chat's words; an id outside
//     the catalogue refuses the whole approval; a staff login is refused,
//     another park group's event is not found;
//   - a group that takes several choices keeps them all through the review and
//     the approval; on a set menu the family already chose through the parent
//     link, an approval without choices keeps those choices, and a new set
//     menu resets the link;
//   - what the approval does not write (title, activities, setup, party
//     details, special requests) is the rest of the same fill, and an editor
//     Save after loading it keeps both;
//   - the review renders its source marks, matches, prices, the date beside
//     the booked one and the notInMenu line waiting for a decision;
//   - a park with no catalogue and a platform with no transcript read the
//     ruling message alone, as SCRUM-660 did.
//
// Run from apps/oto-app:
//   DATABASE_URL=<migrated scratch> TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json npx tsx tests/beo-catalogue-fill.check.ts
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
  console.error("beo-catalogue-fill.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-815";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "info";

const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const { renderTranscript, resolveCatalogueAnswer, loadBeoCatalogue } = await import("../server/lib/beoCatalogueFill");
const { resolveSetMenuLines } = await import("../server/lib/setMenuResolve");
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, undecidedLines, fillBeyondApproval } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;
type BeoAiApproveBody = import("../shared/beoAiFill").BeoAiApproveBody;
type TranscriptRef = import("../server/lib/beoCatalogueFill").TranscriptRef;

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
const tenantA = randomUUID();
const tenantB = randomUUID();
const park = randomUUID();
const parkB = randomUUID();
const parkB2 = randomUUID();
const user = { manager: randomUUID(), staff: randomUUID(), b: randomUUID() };
const cat = {
  floresta: randomUUID(),
  setMenu: randomUUID(),
  setMenu2: randomUUID(),
  reservedTable: randomUUID(),
  balloons: randomUUID(),
  kidsTable: randomUUID(),
  bubble: randomUUID(),
  face: randomUUID(),
  zombie: randomUUID(),
  otherPackage: randomUUID(), // park group B's: never matched for A
};
const KEYS = ["ru", "th", "en", "junk", "refused", "b", "noTranscript", "multi", "parent"] as const;
type Key = (typeof KEYS)[number];
const ev = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const conv = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
const msgIds = Object.fromEntries(KEYS.map((k) => [k, [randomUUID(), randomUUID(), randomUUID(), randomUUID()]])) as Record<Key, string[]>;
const PIZZA = "item_cf_bday_pizza";
const HOT_DISH = "item_cf_bday_hot_dish";
const DRINKS = "item_cf_bday_drinks";
const BOOKED = "2099-11-21";

// --- Three conversations: the family asks, the team confirms, one wish is never confirmed ---------

type Line = { author: "customer" | "staff"; text: string };
const CONVERSATIONS: Record<"ru" | "th" | "en", Line[]> = {
  ru: [
    { author: "customer", text: "Здравствуйте! Хотим день рождения Маши 21 ноября, пакет Флореста. И аквагрим, если можно. RU-815" },
    { author: "staff", text: "Здравствуйте! Флореста свободна. Пицца в сет-меню: Маргарита, Гавайская или Пепперони?" },
    { author: "customer", text: "Пицца Маргарита. И суши для детей, пожалуйста." },
    { author: "staff", text: "Подтверждаем: 21 ноября в 14:00, пакет Флореста 16 900 бат, 12 детей и 6 взрослых. Пицца Маргарита, дополнительно картошка фри. Бабл-шоу 5 000 бат. Стол для взрослых. Предоплата 5 000 получена." },
  ],
  th: [
    { author: "customer", text: "สวัสดีค่ะ อยากจัดวันเกิดน้องมะลิ 21 พฤศจิกายน แพ็กเกจฟลอเรสต้า อยากได้ระบายสีหน้าด้วยค่ะ TH-815" },
    { author: "staff", text: "สวัสดีค่ะ ฟลอเรสต้าว่างค่ะ พิซซ่าเลือกได้: มาร์การิต้า ฮาวายเอี้ยน หรือเปปเปอโรนี" },
    { author: "customer", text: "พิซซ่ามาร์การิต้าค่ะ แล้วก็ซูชิสำหรับเด็ก" },
    { author: "staff", text: "ยืนยันค่ะ 21 พฤศจิกายน เวลา 14.00 น. แพ็กเกจฟลอเรสต้า เด็ก 12 คน ผู้ใหญ่ 6 คน พิซซ่ามาร์การิต้า เพิ่มเฟรนช์ฟรายส์ บับเบิ้ลโชว์ 5,000 บาท มัดจำ 5,000 บาท ได้รับแล้ว" },
  ],
  en: [
    { author: "customer", text: "Hi! A birthday for Emma on 21 November, the Floresta package please. Could we have face painting too? EN-815" },
    { author: "staff", text: "Hello! Floresta is free that day. For the pizza: Margherita, Hawaiian or Pepperoni?" },
    { author: "customer", text: "Margherita pizza please, and some sushi for the kids." },
    { author: "staff", text: "Confirmed: 21 November at 14:00, Floresta package 16,900 THB, 12 kids and 6 adults. Margherita pizza, extra fries, bubble show 5,000 THB. Deposit 5,000 THB received." },
  ],
};
const WORDS = {
  ru: { pkg: "пакет Флореста", pizza: "пицца Маргарита", fries: "картошка фри", sushi: "суши", bubble: "Бабл-шоу", face: "аквагрим", child: "Маша", date: "21 ноября", activities: "Бабл-шоу и игры" },
  th: { pkg: "แพ็กเกจฟลอเรสต้า", pizza: "พิซซ่ามาร์การิต้า", fries: "เฟรนช์ฟรายส์", sushi: "ซูชิ", bubble: "บับเบิ้ลโชว์", face: "ระบายสีหน้า", child: "น้องมะลิ", date: "21 พฤศจิกายน", activities: "บับเบิ้ลโชว์" },
  en: { pkg: "Floresta package", pizza: "Margherita pizza", fries: "extra fries", sushi: "sushi", bubble: "bubble show", face: "face painting", child: "Emma", date: "21 November", activities: "Bubble show and games" },
};
const at = (i: number) => new Date(Date.UTC(2026, 10, 3, 7, i * 7)).toISOString();
const transcriptOf = (lang: "ru" | "th" | "en", ids: string[]) => CONVERSATIONS[lang].map((l, i) => ({ id: ids[i]!, author: l.author, at: at(i), text: l.text }));
/** The four lines' numbers, as the server reads them: 1 and 3 the family's, 2 and 4 the team's. */
const REFS: TranscriptRef[] = [1, 2, 3, 4].map((line) => ({
  line, id: `line-${line}`, source: line % 2 === 1 ? "family" : "team", at: at(line - 1), ruling: line === 4,
}));

/**
 * The stub model's answer to a conversation: the free-text fill and the
 * catalogue section, the way the prompt asks for it. On purpose, it calls the
 * family's face-painting line the team's (`source: "team"` on line 1): the
 * line's author must win.
 */
function answerFor(lang: "ru" | "th" | "en") {
  const w = WORDS[lang];
  return {
    summary: `ZZ ${lang}`,
    event: {
      title: `ZZ party ${lang}`, childName: w.child, numChildren: 12, numAdults: 6, startTime: "14:00",
      eventDate: "2026-11-21", eventDateText: w.date, activities: w.activities, specialRequests: "ZZ no nuts",
    },
    setupPlan: { readyBy: "13:30" },
    kitchenPlan: { kidsMenu: [{ itemName: w.pizza, quantity: 1 }] },
    partyDetails: { packageName: w.pkg, prepaymentReceived: 5000, depositDate: "2026-11-03" },
    catalogue: {
      package: { templateId: cat.floresta, said: w.pkg, chatPrice: lang === "en" ? "16,900" : 16900, line: 4, source: "team" },
      addOns: lang === "ru" ? [{ lineId: cat.reservedTable, said: "Стол для взрослых", quantity: 1, line: 4, source: "team" }] : [],
      setMenu: {
        templateId: cat.setMenu,
        line: 4,
        source: "team",
        choices: [{ itemId: PIZZA, option: "margherita", said: w.pizza, line: 4, source: "team" }],
      },
      menuLines: [
        { productCode: "cf-11", itemName: w.fries, menu: "kids", quantity: 1, line: 4, source: "team" },
        { productCode: null, itemName: w.sushi, menu: "kids", quantity: 1, notInMenu: true, line: 3, source: "family" },
      ],
      entertainment: [
        { templateId: cat.bubble, said: w.bubble, quantity: 1, chatPrice: 5000, line: 4, source: "team" },
        { templateId: cat.face, said: w.face, quantity: 1, line: 1, source: "team" },
      ],
      event: {
        childName: { value: w.child, line: 1, source: "family" },
        numChildren: { value: 12, line: 4, source: "team" },
        numAdults: { value: "6", line: 4, source: "team" },
        startTime: { value: "14.00", line: 4, source: "team" },
      },
      cake: { mode: "internal", notes: "ice-cream cake", line: 4, source: "team" },
      deposit: { amount: "5,000", paid: true, date: "2026-11-03", line: 4, source: "team" },
    },
  };
}
const JUNK_ANSWER = {
  summary: "ZZ junk",
  catalogue: {
    package: { templateId: cat.otherPackage, said: "Super Party package", line: 2, source: "team" },
    setMenu: { templateId: cat.setMenu, line: 2, source: "team", choices: [{ itemId: PIZZA, option: "Four cheese", said: "four cheese pizza", line: 2, source: "team" }] },
    menuLines: [{ productCode: "CF-999", itemName: "dragon fruit", menu: "kids", line: 2, source: "team" }, "not an object", { menu: "kids" }],
    entertainment: [{ templateId: randomUUID(), said: "Magic show", quantity: 1, chatPrice: 3000, line: 2, source: "team" }],
    addOns: [{ lineId: cat.reservedTable, said: "adult table", line: 2, source: "team" }],
  },
};
/** A drinks group that takes several choices: the family asks juice, the team confirms juice and mors. */
const MULTI_ANSWER = {
  summary: "ZZ multi",
  event: { childName: "Lena", eventDate: BOOKED, eventDateText: "21 November" },
  catalogue: {
    package: { templateId: cat.floresta, said: "Floresta", line: 2 },
    setMenu: {
      templateId: cat.setMenu,
      line: 2,
      choices: [
        { itemId: PIZZA, option: "Margherita", said: "Margherita pizza", line: 2 },
        { itemId: DRINKS, option: "Juice", said: "juice", line: 1, source: "team" },
        { itemId: DRINKS, option: "juice", said: "juice", line: 2 },
        { itemId: DRINKS, option: "Mors", said: "mors", line: 2 },
      ],
    },
  },
};

/** Which stub conversation a model call reads, by words its ruling message holds (both reads carry it). */
function conversationOf(user: string): "ru" | "th" | "en" | "junk" | "multi" | null {
  if (user.includes("JUNK-815")) return "junk";
  if (user.includes("MULTI-815")) return "multi";
  if (user.includes(CONVERSATIONS.ru[3]!.text)) return "ru";
  if (user.includes(CONVERSATIONS.th[3]!.text)) return "th";
  if (user.includes(CONVERSATIONS.en[3]!.text)) return "en";
  return null;
}

const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    const which = conversationOf(call.user);
    if (!which) return JSON.stringify({ summary: "ZZ plain", event: { childName: "Plain" } });
    const { catalogue, ...form } = which === "junk" ? JUNK_ANSWER : which === "multi" ? MULTI_ANSWER : answerFor(which);
    // The conversation's read answers the catalogue only; the form's read answers the form
    // (and, handed the catalogue with no conversation, the catalogue too).
    if (call.system.includes("THE CONVERSATION")) return JSON.stringify({ catalogue });
    return JSON.stringify(call.system.includes("THE PARK'S CATALOGUE") ? { ...form, catalogue } : form);
  },
};

type TLine = { id: string; author: "customer" | "staff"; at: string; text: string };
const confirmation = (key: Key, eventId: string, transcript: TLine[]): InboxRead => {
  const ruling = transcript.at(-1)!;
  return {
    ok: true,
    confirmation: {
      conversationId: conv[key],
      eventId,
      message: { id: ruling.id, body: ruling.text, bodyLanguage: null, authorName: "ZZ TEST Manager", sentAt: ruling.at, createdAt: ruling.at },
      scanned: 2,
      transcript,
      transcriptCut: false,
    },
  };
};
const JUNK_LINES: TLine[] = [
  { id: msgIds.junk[0]!, author: "customer", at: at(0), text: "Hi, a party please JUNK-815" },
  { id: msgIds.junk[1]!, author: "staff", at: at(1), text: "Confirmed 21 November 14:00, Super Party package, four cheese pizza, dragon fruit, magic show 3,000, 12 kids JUNK-815" },
];
const MULTI_LINES: TLine[] = [
  { id: msgIds.multi[0]!, author: "customer", at: at(0), text: "Hello! A party for Lena on 21 November, Floresta please. Juice for the kids. MULTI-815" },
  { id: msgIds.multi[1]!, author: "staff", at: at(1), text: "Confirmed 21 November 14:00, Floresta, 12 kids, Margherita pizza, drinks juice and mors. MULTI-815" },
];
const inbox = new Map<string, InboxRead>([
  [conv.ru, confirmation("ru", ev.ru, transcriptOf("ru", msgIds.ru))],
  [conv.th, confirmation("th", ev.th, transcriptOf("th", msgIds.th))],
  [conv.en, confirmation("en", ev.en, transcriptOf("en", msgIds.en))],
  [conv.refused, confirmation("refused", ev.refused, transcriptOf("en", msgIds.refused))],
  [conv.junk, confirmation("junk", ev.junk, JUNK_LINES)],
  [conv.b, confirmation("b", ev.b, transcriptOf("en", msgIds.b))],
  [conv.multi, confirmation("multi", ev.multi, MULTI_LINES)],
  [conv.parent, confirmation("parent", ev.parent, transcriptOf("en", msgIds.parent))],
]);
// A platform older than SCRUM-815: no transcript in its answer.
{
  const ruling = { id: msgIds.noTranscript[3]!, text: CONVERSATIONS.en[3]!.text, at: at(3) };
  inbox.set(conv.noTranscript, {
    ok: true,
    confirmation: {
      conversationId: conv.noTranscript, eventId: ev.noTranscript,
      message: { id: ruling.id, body: ruling.text, bodyLanguage: null, authorName: null, sentAt: ruling.at, createdAt: ruling.at },
      scanned: 1,
    } as never,
  });
}

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const who = req.get("x-test-as");
  const persona =
    who === "manager" ? { id: user.manager, tenantId: tenantA, role: "manager", allowed: [park] }
      : who === "staff" ? { id: user.staff, tenantId: tenantA, role: "staff", allowed: [park] }
        : who === "b" ? { id: user.b, tenantId: tenantB, role: "manager", allowed: [parkB] }
          : null;
  if (!persona) return res.status(401).json({ message: "Not signed in" });
  (req as any).isAuthenticated = () => true;
  (req as any).user = { id: persona.id, tenantId: persona.tenantId, role: persona.role };
  (req as any).userWithAccess = {
    id: persona.id, tenantId: persona.tenantId, isActive: true, role: persona.role, hasAllBranchesAccess: false, allowedBranchIds: persona.allowed,
  };
  next();
}

const servers: Server[] = [];
const app = express();
app.use(express.json({ limit: "1mb" }));
// The BEO's own routes (its read and its Save) take the session the app's passport would give.
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
registerAIRoutes(app, fakeAuth, {
  ai,
  inboxConfirmation: async (_req, conversationId) => inbox.get(conversationId) ?? { ok: false, reason: "inbox_unreachable" },
});
registerBeoRoutes(app);
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function send(method: string, path: string, body: unknown, as: "manager" | "staff" | "b" | null = "manager") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { "x-test-as": as } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const post = (path: string, body: unknown, as: "manager" | "staff" | "b" | null = "manager") => send("POST", path, body, as);
const fill = (eventId: string, as: "manager" | "b" = "manager") => post(`/api/events/${eventId}/beo/ai-fill/inbox`, { existingData: { event: { title: "ZZ TEST" } } }, as);
const approve = (eventId: string, body: unknown, as: "manager" | "staff" | "b" = "manager") => post(`/api/events/${eventId}/beo/ai-fill/approve`, body, as);
const readBeo = (eventId: string) => send("GET", `/api/events/${eventId}/beo`, undefined);

/** What the BEO holds: every table an approval writes. */
async function beoRows(eventId: string) {
  const [event] = await q("select num_children, num_adults, start_time, end_time, event_date, child_name, title, activities, special_requests, internal_staff_notes from core_events where id = $1", [eventId]);
  return {
    event,
    snapshot: (await q("select * from beo_package_snapshots where event_id = $1", [eventId]))[0] ?? null,
    snapshotItems: await q("select i.* from beo_package_snapshot_items i join beo_package_snapshots s on s.id = i.snapshot_id where s.event_id = $1 order by i.sort_order", [eventId]),
    kitchen: (await q("select * from beo_kitchen_plans where event_id = $1", [eventId]))[0] ?? null,
    bar: (await q("select * from beo_bar_plans where event_id = $1", [eventId]))[0] ?? null,
    selection: (await q("select * from beo_set_menu_selections where event_id = $1", [eventId]))[0] ?? null,
    entertainment: await q("select * from beo_entertainment_selections where event_id = $1 order by sort_order", [eventId]),
    billing: (await q("select * from beo_event_billing where event_id = $1", [eventId]))[0] ?? null,
    activity: await q("select summary_text, metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at", [`%${eventId}%`]),
  };
}
const nothingWritten = async (eventId: string) => {
  const rows = await beoRows(eventId);
  assert.equal(rows.snapshot, null, "no package snapshot");
  assert.equal(rows.kitchen, null, "no kitchen plan");
  assert.equal(rows.bar, null, "no bar plan");
  assert.equal(rows.selection, null, "no set-menu selection");
  assert.deepEqual(rows.entertainment, [], "no entertainment");
  assert.equal(rows.billing, null, "no billing");
  assert.equal(rows.event.num_children, null, "the event's counts as they were");
  assert.equal(rows.event.start_time, "10:00", "the event's time as it was");
  assert.equal(rows.event.event_date, BOOKED, "the event's date as it was");
  return rows;
};
const setMenuLinesOf = (kitchen: any) => ((kitchen?.menus?.kids ?? []) as any[]).filter((l) => l.source === "set_menu").map((l) => [l.itemName, l.groupId]);
/** An approval body speaking only to the set menu. */
const setMenuOnly = (setMenu: BeoAiApproveBody["setMenu"]): BeoAiApproveBody => ({
  conversationId: null, messageId: null, package: null, setMenu, menuLines: [], entertainment: [], otherLines: [], event: {}, cake: null, deposit: null, sources: [],
});

const reviews: Partial<Record<"ru" | "th" | "en", BeoAiReview>> = {};
const fills: Partial<Record<"ru" | "th" | "en", any>> = {};
const sources: Partial<Record<"ru" | "th" | "en", any>> = {};
let ruApproved: BeoAiApproveBody | null = null;

// The set menu as script/seed-birthday-packages.mjs prints it, with a drinks group that takes several.
const setMenuItems = [
  { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian", "Pepperoni"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27", Pepperoni: "CF-31" } },
  { id: HOT_DISH, type: "choice_group", label: "Hot dish", options: ["Chicken schnitzel", "Fish fingers"], allowMultiple: false, optionProductCodes: { "Chicken schnitzel": "CF-37" } },
  { id: DRINKS, type: "choice_group", label: "Drinks", options: ["Juice", "Mors", "Cola"], allowMultiple: true, optionProductCodes: { Juice: "CF-50", Mors: "CF-51" } },
  { id: "item_cf_bday_fries", type: "always_included", label: "French fries", productCode: "CF-11" },
  { id: "item_cf_bday_fruit_skewers", type: "always_included", label: "Fruit skewers" },
];
/** The set menu's own order of its items, which the kitchen plan's set-menu lines follow. */
const byMenuOrder = (lines: Array<Array<string | undefined>>) =>
  [...lines].sort((a, b) => setMenuItems.findIndex((i) => i.id === a[1]) - setMenuItems.findIndex((i) => i.id === b[1]));

try {
  // --- Park group A with the Floresta catalogue, B with none.
  await q("insert into tenants (id, name, slug) values ($1, $2, $3), ($4, $5, $6)", [
    tenantA, `ZZ TEST 815 A ${run}`, `zz-815-a-${run}`, tenantB, `ZZ TEST 815 B ${run}`, `zz-815-b-${run}`,
  ]);
  await q(
    `insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, 'ZZ TEST Central Floresta', 'ZZ TEST', 'Asia/Bangkok'),
       ($3, $4, 'ZZ TEST Park B', 'ZZ TEST', 'Asia/Bangkok'), ($5, $4, 'ZZ TEST Park B2', 'ZZ TEST', 'Asia/Bangkok')`,
    [park, tenantA, parkB, tenantB, parkB2],
  );
  for (const [id, role] of [[user.manager, "manager"], [user.staff, "staff"], [user.b, "manager"]] as const) {
    await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 815', $3, true, false)", [
      id, `zz-815-${id.slice(0, 8)}@example.com`, role,
    ]);
  }
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Birthday set menu, Central Floresta', $3)", [cat.setMenu, tenantA, JSON.stringify(setMenuItems)]);
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'ZZ light set menu', $3)", [
    cat.setMenu2, tenantA, JSON.stringify([{ id: "item_light_jug", type: "always_included", label: "Juice jug" }]),
  ]);
  await q(
    `insert into birthday_package_templates (id, tenant_id, name, base_price, kids_included, adults_included, socks_included, hours,
       price_weekday, price_weekend, extra_child_weekday, extra_child_weekend, set_menu_template_id, branch_id, sort_order)
     values ($1, $2, 'Birthday package, Central Floresta', 1690000, 10, 4, -1, 3, 1690000, 2090000, 130000, 150000, $3, $4, 1),
            ($5, $6, 'ZZ TEST Park B2 package', 100000, 10, 4, null, 2, null, null, null, null, null, $7, 1)`,
    [cat.floresta, tenantA, cat.setMenu, park, cat.otherPackage, tenantB, parkB2],
  );
  await q(
    `insert into package_line_item_templates (id, package_template_id, category, label, qty_default, qty_editable, included, default_unit_price, billable_by_default, sort_order, fnb_credit, prints_voucher)
     values ($1, $4, 'setup', 'Kids'' table reserved for 3 hours', 1, false, true, 0, false, 0, null, false),
            ($2, $4, 'setup', 'Reserved table for adults, up to 10 adults', 0, true, false, 500000, true, 1, 500000, true),
            ($3, $4, 'setup', 'Classic balloon decoration', 0, true, false, 400000, true, 2, null, false)`,
    [cat.kidsTable, cat.reservedTable, cat.balloons, cat.floresta],
  );
  await q(
    `insert into entertainment_package_templates (id, tenant_id, name, category, duration_minutes, default_price, billable_by_default, unit, sort_order)
     values ($1, $4, 'Bubble show', 'Shows', 30, 550000, true, 'session', 1),
            ($2, $4, 'Face painting', 'Other', 60, 200000, true, 'hour', 2),
            ($3, $4, 'Zombie game', 'Games', 30, 400000, true, 'session', 3)`,
    [cat.bubble, cat.face, cat.zombie, tenantA],
  );
  const event = (id: string, tenant: string, branch: string, conversation: string, title: string) =>
    q(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, status, inbox_conversation_id)
       values ($1, $2, $3, 'birthday', $4, $6, '10:00', 'tentative', $5)`,
      [id, tenant, branch, title, conversation, BOOKED],
    );
  for (const k of KEYS) if (k !== "b") await event(ev[k], tenantA, park, conv[k], `ZZ TEST 815 ${k}`);
  await event(ev.b, tenantB, parkB, conv.b, "ZZ TEST 815 B");

  await check("conversationAndCatalogueReachTheModel", async () => {
    for (const lang of ["ru", "th", "en"] as const) {
      const before = modelCalls.length;
      const res = await fill(ev[lang]);
      assert.equal(res.status, 200, `${lang}: ${JSON.stringify(res.body)}`);
      const calls = modelCalls.slice(before);
      assert.equal(calls.length, 2, `${lang}: two reads, the form's and the conversation's`);
      const conversationCall = calls.find((c) => c.system.includes("THE CONVERSATION"))!;
      const formCall = calls.find((c) => !c.system.includes("THE CONVERSATION"))!;
      assert.ok(conversationCall && formCall, `${lang}: one read of each`);
      // The conversation's read: numbered, oldest first, the ruling message marked, on the park's clock (UTC+7).
      assert.ok(conversationCall.user.includes(`#1 [family] 2026-11-03 14:00: ${CONVERSATIONS[lang][0]!.text}`), `${lang}: line 1 is the family's`);
      assert.ok(conversationCall.user.includes(`#2 [team] 2026-11-03 14:07: `), `${lang}: line 2 is the team's`);
      assert.ok(conversationCall.user.includes(`#4 [team, RULING] 2026-11-03 14:21: ${CONVERSATIONS[lang][3]!.text}`), `${lang}: the ruling line`);
      // Its rules, the catalogue with its ids, codes and prices in baht, and only the catalogue key asked for.
      for (const piece of ["THE CONVERSATION", "The team's confirmation wins", "The family's values are the defaults", 'Answer ONLY the "catalogue" key', "THE PARK'S CATALOGUE", cat.floresta, cat.reservedTable, cat.setMenu, PIZZA, cat.bubble, '"CF-24"', '"priceWeekday":16900', '"catalogue": {', "Never invent an item", "never price or total anything"]) {
        assert.ok(conversationCall.system.includes(piece), `${lang}: the conversation's prompt carries ${piece}`);
      }
      // SCRUM-814's today ends the prompt, after the catalogue.
      const today = conversationCall.system.lastIndexOf("Today at ZZ TEST Central Floresta is ");
      assert.ok(today > conversationCall.system.indexOf("THE PARK'S CATALOGUE"), `${lang}: today comes after the catalogue`);
      assert.ok(formCall.system.includes("Today at ZZ TEST Central Floresta is "), `${lang}: the form's read knows today too`);
      // Another park group's package is never offered.
      assert.ok(!conversationCall.system.includes(cat.otherPackage), `${lang}: B's package is not in A's catalogue`);
      // The form's read: the ruling message alone, as SCRUM-660 read it; the family's lines never reach it.
      assert.ok(formCall.user.endsWith(CONVERSATIONS[lang][3]!.text), `${lang}: the form reads the ruling message`);
      assert.ok(!formCall.user.includes("#1 [") && !formCall.user.includes(CONVERSATIONS[lang][0]!.text), `${lang}: no family line in the form's read`);
      assert.ok(!formCall.system.includes("THE PARK'S CATALOGUE") && !formCall.system.includes("THE CONVERSATION"));
      reviews[lang] = res.body.review;
      fills[lang] = res.body.fill;
      sources[lang] = res.body.source;
      assert.ok(res.body.review, `${lang}: a review`);
      assert.deepEqual(res.body.review.transcript, { lines: 4, cut: false });
      assert.deepEqual(res.body.review.ruling, { source: "team", at: at(3), line: 4 }, `${lang}: the ruling message's place`);
      assert.equal(res.body.review.parentSelection, null);
      assert.equal(res.body.review.finalMessage, CONVERSATIONS[lang][3]!.text, `${lang}: Final Message to Parent is the ruling message`);
      // The free-text fill of before still rides beside it, for Load into Editor and the rest after approval.
      assert.equal(res.body.fill.event.childName, WORDS[lang].child);
      assert.equal(res.body.fill.event.eventDate, "2026-11-21");
      assert.ok(!("catalogue" in res.body.fill), "the catalogue section is read apart from the free-text fill");
    }
  });

  await check("idsMatchAndSourcesAreTheLines", () => {
    for (const lang of ["ru", "th", "en"] as const) {
      const p = reviews[lang]!.proposal;
      const ruling = { source: "team", at: at(3), line: 4 };
      assert.deepEqual(p.package, { templateId: cat.floresta, said: WORDS[lang].pkg, chatPrice: 16900, from: ruling }, `${lang}: the package`);
      assert.equal(p.setMenu?.templateId, cat.setMenu);
      assert.deepEqual(p.setMenu?.choices, [{ itemId: PIZZA, option: "Margherita", said: WORDS[lang].pizza, from: ruling }], `${lang}: the pizza choice, spelt as the menu lists it`);
      const fries = p.menuLines.find((l) => l.productCode === "CF-11");
      assert.deepEqual(fries && { ...fries }, {
        menu: "kids", itemName: WORDS[lang].fries, quantity: 1, productCode: "CF-11", matchedName: "French fries", notInMenu: false, chatPrice: null, from: ruling,
      }, `${lang}: the extra dish matched to its code`);
      const sushi = p.menuLines.find((l) => l.itemName === WORDS[lang].sushi);
      assert.equal(sushi?.notInMenu, true, `${lang}: a dish the menu lacks is a notInMenu line`);
      assert.equal(sushi?.productCode, null);
      assert.deepEqual(sushi?.from, { source: "family", at: at(2), line: 3 });
      const bubble = p.entertainment.find((e) => e.templateId === cat.bubble);
      assert.equal(bubble?.chatPrice, 5000, `${lang}: the chat's price, beside the catalogue's 5,500`);
      assert.equal(bubble?.from.source, "team");
      // The family-only wish: the model called it the team's, the line is the family's.
      const face = p.entertainment.find((e) => e.templateId === cat.face);
      assert.equal(face?.name, "Face painting");
      assert.deepEqual(face?.from, { source: "family", at: at(0), line: 1 }, `${lang}: the family-only wish is marked the family's`);
      assert.deepEqual(p.event.childName, { value: WORDS[lang].child, from: { source: "family", at: at(0), line: 1 } });
      assert.deepEqual(p.event.numAdults, { value: 6, from: ruling });
      assert.deepEqual(p.event.startTime, { value: "14:00", from: ruling });
      assert.deepEqual(p.deposit, { amount: 5000, paid: true, date: "2026-11-03", from: ruling });
      assert.deepEqual(p.cake, { mode: "INTERNAL", notes: "ice-cream cake", time: null, from: ruling });
      assert.deepEqual(reviews[lang]!.replaces, [], `${lang}: an empty BEO replaces nothing`);
    }
    const ru = reviews.ru!.proposal;
    assert.deepEqual(ru.addOns, [{ lineId: cat.reservedTable, quantity: 1, said: "Стол для взрослых", chatPrice: null, from: { source: "team", at: at(3), line: 4 } }]);
    // The catalogue the review shows: A's park only, with its set menus' food codes.
    const view = reviews.ru!.catalogue;
    assert.deepEqual(view.packages.map((x) => x.id), [cat.floresta]);
    assert.deepEqual(view.food.find((f) => f.code === "CF-24")?.names, ["Margherita"]);
    assert.equal((view as any).place, undefined, "the park's zone stays on the server");
  });

  await check("unknownIdsBecomeFreeLines", async () => {
    const res = await fill(ev.junk);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body.review.proposal;
    assert.equal(p.package, null, "another park group's package is not this catalogue's");
    assert.deepEqual(p.otherLines.map((o: any) => o.text), ["Super Party package", "adult table"], "the package and an add-on with no package, as free lines");
    assert.deepEqual(p.setMenu.choices, [], "an option the menu does not list is not a choice");
    assert.deepEqual(
      p.menuLines.map((l: any) => [l.itemName, l.notInMenu, l.productCode]),
      [["four cheese pizza", true, null], ["dragon fruit", true, null]],
      "the unlisted option and an unknown code are free lines in the conversation's words; junk entries are dropped",
    );
    assert.deepEqual(p.entertainment.map((e: any) => [e.templateId, e.name, e.notInCatalogue, e.chatPrice]), [[null, "Magic show", true, 3000]]);
    await nothingWritten(ev.junk);
  });

  await check("nothingWrittenBeforeApproval", async () => {
    for (const lang of ["ru", "th", "en"] as const) {
      const rows = await nothingWritten(ev[lang]);
      // The fill's own activity row says what it read, never the chat's words.
      assert.equal(rows.activity.length, 1);
      const meta = JSON.parse(rows.activity[0]!.metadata_json);
      assert.equal(meta.transcriptLines, 4);
      assert.equal(meta.catalogueRead.outcome, "filled");
      assert.deepEqual(meta.catalogue, { package: true, addOns: lang === "ru" ? 1 : 0, setMenu: true, choices: 1, menuLines: 1, notInMenu: 1, entertainment: 2, notInCatalogue: 0 });
      assert.equal(rows.activity[0]!.summary_text, `AI Fill read the inbox conversation for the BEO of "ZZ TEST 815 ${lang}"`);
      for (const word of Object.values(WORDS[lang])) assert.ok(!rows.activity[0]!.metadata_json.includes(word), `${lang}: no "${word}" in the activity row`);
    }
  });

  await check("reviewRendersSourcesMatchesPricesAndTheDate", () => {
    const review = reviews.ru!;
    const state = initialReviewState(review, { fill: fills.ru, bookedDate: BOOKED });
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
    assert.ok(html.includes("пицца Маргарита → Margherita (CF-24)"), "the matched choice reads chat → catalogue (code)");
    assert.ok(html.includes("картошка фри → French fries (CF-11)"), "the extra dish too");
    assert.ok(html.includes('data-source="team"') && html.includes("from the team"));
    assert.ok(html.includes('data-source="family"') && html.includes("from the family"), "the family's values are marked");
    assert.ok(html.includes("Catalogue ฿5,500") && html.includes("Chat ฿5,000"), "the chat's price beside the catalogue's");
    assert.ok(html.includes("the catalogue&#x27;s is kept"), "and the catalogue's is kept");
    assert.ok(html.includes("Catalogue ฿16,900 / ฿20,900") && html.includes("Chat ฿16,900"), "the package's day prices beside the chat's");
    assert.ok(html.includes('data-testid="ai-review-not-in-menu"'), "the dish the menu lacks is highlighted");
    assert.ok(html.includes("Keep as a free line") && html.includes("Leave out"));
    assert.equal(undecidedLines(state), 1, "Approve and create waits for the sushi decision");
    // SCRUM-814: the date the confirmation names beside the booked one, marked, applied only when ticked.
    assert.ok(html.includes('data-testid="ai-review-event-date"'), "the Date row");
    assert.ok(html.includes("Sat 21 Nov 2026") && html.includes("21 ноября"), "the read date and the message's words for it");
    assert.ok(html.includes('data-testid="text-ai-review-date-differs"') && html.includes('data-testid="checkbox-ai-review-event-date"'), "not the booked day: a tick");
    assert.equal(state.useDate, false, "unticked as it opens");
    assert.equal(approveBodyOf(review, state, { conversationId: null, messageId: null }).event.eventDate, undefined, "an unticked date is not sent");
    for (const lang of ["th", "en"] as const) {
      const other = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review: reviews[lang]!, state: initialReviewState(reviews[lang]!), onChange: () => undefined }));
      assert.ok(other.includes(`${WORDS[lang].pizza} → Margherita (CF-24)`), `${lang}: the pizza match`);
    }
  });

  await check("approvalWritesTheBeo", async () => {
    // Russian: everything as proposed, the sushi kept as a free line, the read date ticked.
    const review = reviews.ru!;
    const state = initialReviewState(review, { fill: fills.ru, bookedDate: BOOKED });
    state.menuLines = state.menuLines.map((l) => (l.notInMenu ? { ...l, decision: "keep" as const } : l));
    state.useDate = true;
    const body = approveBodyOf(review, state, { conversationId: conv.ru, messageId: sources.ru.messageId });
    assert.equal(body.event.eventDate, "2026-11-21", "a ticked date is sent");
    ruApproved = body;
    const res = await approve(ev.ru, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = await beoRows(ev.ru);
    // The package, at the catalogue's prices, the add-on bought.
    assert.equal(rows.snapshot.template_id, cat.floresta);
    assert.equal(rows.snapshot.price_weekday, 1690000, "the catalogue's price, never the chat's");
    assert.deepEqual(rows.snapshotItems.map((i) => [i.source_template_line_item_id, i.qty]), [[cat.kidsTable, 1], [cat.reservedTable, 1], [cat.balloons, 0]]);
    // The kitchen plan: the set menu, the choice as the parent link writes it, the extra dish, the free line.
    assert.equal(rows.kitchen.set_menu_enabled, true);
    assert.equal(rows.kitchen.set_menu_template_id, cat.setMenu);
    const kids = rows.kitchen.menus.kids as any[];
    assert.deepEqual(setMenuLinesOf(rows.kitchen), byMenuOrder([["Margherita", PIZZA], ["French fries", "item_cf_bday_fries"], ["Fruit skewers", "item_cf_bday_fruit_skewers"]]));
    const extras = kids.filter((l) => l.source !== "set_menu");
    assert.deepEqual(extras.map((l) => [l.itemName, l.notes, l.source]), [["French fries", "CF-11", "additional"], ["суши", "Not in the menu", "additional"]]);
    assert.deepEqual(rows.kitchen.simplified_menus.kids, kids);
    assert.equal(rows.kitchen.cake_mode, "INTERNAL");
    assert.equal(rows.selection.template_id, cat.setMenu);
    assert.equal(rows.selection.is_submitted, true);
    assert.deepEqual(rows.selection.selections, [{ groupId: PIZZA, chosenOptions: ["Margherita"] }]);
    // Entertainment at the catalogue's prices: the bubble show (the chat said 5,000) and the family's wish.
    assert.deepEqual(rows.entertainment.map((e) => [e.template_id, e.name, e.price]), [[cat.bubble, "Bubble show", 550000], [cat.face, "Face painting", 200000]]);
    // The counts, times, the ticked date, child, final message and deposit.
    assert.equal(rows.event.num_children, 12);
    assert.equal(rows.event.num_adults, 6);
    assert.equal(rows.event.start_time, "14:00");
    assert.equal(rows.event.event_date, "2026-11-21", "the ticked date is the event's");
    assert.equal(rows.event.child_name, "Маша");
    assert.equal(rows.event.internal_staff_notes, CONVERSATIONS.ru[3]!.text);
    assert.equal(rows.billing.deposit_paid, true);
    assert.equal(rows.billing.deposit_paid_amount, 5000);
    // The deposit where the BEO itself reads it: its GET's Party Details (editor, badge, day-of view, PDF).
    const beo = await readBeo(ev.ru);
    assert.equal(beo.status, 200, JSON.stringify(beo.body));
    assert.equal(beo.body.partyDetails?.prepaymentReceived, 5000, "the BEO shows the prepayment received");
    assert.equal(beo.body.partyDetails?.depositDate, "2026-11-03");
    // One activity row for the approval: sources and matches, never the chat's words.
    const approved = rows.activity.map((r) => JSON.parse(r.metadata_json)).filter((m) => m.step === "approved");
    assert.equal(approved.length, 1);
    const meta = approved[0]!;
    assert.equal(meta.inboxConversationId, conv.ru);
    assert.equal(meta.written.eventDate, true);
    assert.ok(meta.sources.some((s: any) => s.field === "package" && s.source === "team"));
    assert.ok(meta.sources.some((s: any) => s.field === "eventDate" && s.source === "team"), "the date is the team's confirmation's");
    assert.ok(meta.sources.some((s: any) => s.field.startsWith("entertainment:") && s.source === "family"), "the family's wish is recorded as the family's");
    assert.ok(meta.matches.some((m: any) => m.kind === "choice" && m.option === "Margherita" && m.code === "CF-24"));
    assert.ok(meta.matches.some((m: any) => m.kind === "package" && m.id === cat.floresta));
    const row = rows.activity.find((r) => JSON.parse(r.metadata_json).step === "approved")!;
    assert.equal(row.summary_text, `AI Fill approved for the BEO of "ZZ TEST 815 ru"`);
    for (const word of ["Маша", "суши", "пицца", "Бабл"]) assert.ok(!row.metadata_json.includes(word), `no "${word}" in the activity row`);
    // The BEO's timeline was generated again, as the BEO's own Save does.
    const timeline = await q("select source_key from beo_timeline_items where event_id = $1", [ev.ru]);
    assert.ok(timeline.some((t) => t.source_key === "guests_arrive"));
    // A second fill now names what approving again would replace.
    const again = await fill(ev.ru);
    assert.deepEqual(again.body.review.replaces, ["package", "kitchen plan", "entertainment", "deposit"]);
  });

  await check("theRestOfTheFillAfterApproval", async () => {
    // What the approval does not write: the rest of the same fill, read from the ruling message.
    const rest = fillBeyondApproval(fills.ru, ruApproved?.otherLines ?? []) as any;
    assert.ok(rest, "the fill holds more than the approval writes");
    assert.deepEqual(rest.event, { title: "ZZ party ru", activities: WORDS.ru.activities, specialRequests: "ZZ no nuts" });
    assert.deepEqual(rest.setupPlan, { readyBy: "13:30" });
    assert.deepEqual(rest.partyDetails, { packageName: WORDS.ru.pkg }, "Party Details but the deposit the approval wrote");
    for (const owned of ["kitchenPlan"]) assert.equal(rest[owned], undefined, `${owned} is the approval's`);
    // The free lines the approval added to Special Requests ride after the message's own.
    assert.equal((fillBeyondApproval(fills.ru, ["суши"]) as any).event.specialRequests, "ZZ no nuts\nсуши");
    assert.equal(fillBeyondApproval({ event: { childName: "x", numChildren: 3 }, kitchenPlan: { kidsMenu: [] } }), null, "nothing left: no second step");
    // Approving and then the editor's Save with the rest loaded keeps both.
    const beo = (await readBeo(ev.ru)).body;
    const kp = beo.kitchenPlan;
    const save = await send("PUT", `/api/events/${ev.ru}/beo`, {
      event: { title: rest.event.title, activities: rest.event.activities, specialRequests: rest.event.specialRequests },
      setupPlan: { setupRequired: true, readyBy: rest.setupPlan.readyBy, simplifiedTasks: [] },
      kitchenPlan: {
        foodRequired: true,
        cakeMode: kp.cakeMode,
        cakeNotes: kp.cakeNotes,
        cakeTime: kp.cakeTime,
        setMenuEnabled: kp.setMenuEnabled,
        setMenuTemplateId: kp.setMenuTemplateId,
        setMenuSelectionSubmittedAt: kp.setMenuSelectionStatus?.submittedAt ?? null,
        menus: { kids: kp.menus.kids, adults: kp.menus.adults },
        serviceSchedule: [],
      },
      billing: {},
      partyDetails: { ...beo.partyDetails, ...rest.partyDetails },
    });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const after = await beoRows(ev.ru);
    assert.equal(after.event.title, "ZZ party ru");
    assert.equal(after.event.activities, WORDS.ru.activities);
    assert.equal(after.snapshot.template_id, cat.floresta, "the approved package stays");
    assert.equal(after.entertainment.length, 2, "the approved entertainment stays");
    assert.deepEqual(setMenuLinesOf(after.kitchen), byMenuOrder([["Margherita", PIZZA], ["French fries", "item_cf_bday_fries"], ["Fruit skewers", "item_cf_bday_fruit_skewers"]]), "the approved set menu stays");
    const partyDetails = (await readBeo(ev.ru)).body.partyDetails;
    assert.equal(partyDetails.prepaymentReceived, 5000, "the approved deposit stays");
    assert.equal(partyDetails.packageName, WORDS.ru.pkg, "the rest's Party Details are saved");
  });

  await check("reviewerEditsAreWhatIsWritten", async () => {
    // Thai: the reviewer leaves out the family's wish and the sushi, and changes the adults; the date is left unticked.
    const review = reviews.th!;
    const state = initialReviewState(review, { fill: fills.th, bookedDate: BOOKED });
    state.entertainment = state.entertainment.filter((e) => e.templateId !== cat.face);
    state.menuLines = state.menuLines.map((l) => (l.notInMenu ? { ...l, decision: "drop" as const } : l));
    state.numAdults = { value: 8, from: state.numAdults!.from, changed: true };
    assert.equal(undecidedLines(state), 0);
    const body = approveBodyOf(review, state, { conversationId: conv.th, messageId: sources.th.messageId });
    assert.ok(body.sources.some((s) => s.field === "numAdults" && s.source === "staff"), "a changed field is the reviewer's");
    const res = await approve(ev.th, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = await beoRows(ev.th);
    assert.deepEqual(rows.entertainment.map((e) => e.template_id), [cat.bubble], "the left-out wish is not written");
    assert.deepEqual((rows.kitchen.menus.kids as any[]).filter((l) => l.source !== "set_menu").map((l) => l.itemName), ["French fries"], "the dropped sushi is not written");
    assert.equal(rows.event.num_adults, 8);
    assert.equal(rows.event.event_date, BOOKED, "an unticked date leaves the booked one");
    assert.deepEqual(rows.snapshotItems.map((i) => i.qty), [1, 0, 0], "no add-on bought");
  });

  await check("approvalRefusesWhatTheCatalogueLacks", async () => {
    const review = reviews.en!;
    const good = approveBodyOf(review, { ...initialReviewState(review), menuLines: [] }, { conversationId: conv.refused, messageId: null });
    const cases: Array<[string, unknown]> = [
      ["another park group's package", { ...good, package: { templateId: cat.otherPackage, addOns: [] } }],
      ["an add-on of no package", { ...good, package: { templateId: cat.floresta, addOns: [{ lineId: cat.kidsTable, quantity: 1 }] } }],
      ["an option the menu lacks", { ...good, setMenu: { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Four cheese"] }] } }],
      ["two pizzas where the menu takes one", { ...good, setMenu: { templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Margherita", "Hawaiian"] }] } }],
      ["an unknown entertainment", { ...good, entertainment: [{ templateId: randomUUID(), name: "x", quantity: 1, notes: null }] }],
      ["an unknown food code", { ...good, menuLines: [{ menu: "kids", itemName: "x", quantity: 1, productCode: "CF-999", notes: null }] }],
      ["an end before the start", { ...good, event: { ...good.event, startTime: "15:00", endTime: "14:00" } }],
      ["a date that is no day", { ...good, event: { ...good.event, eventDate: "2026-02-30" } }],
    ];
    for (const [what, body] of cases) {
      const res = await approve(ev.refused, body);
      assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await approve(ev.refused, { ...good, extra: 1 })).status, 400, "a body off its shape");
    // A staff login may not write a BEO; another park group's event is not found.
    assert.equal((await approve(ev.refused, good, "staff")).status, 403);
    assert.equal((await approve(ev.refused, good, "b")).status, 404);
    assert.equal((await approve(ev.refused, good, null as never)).status, 401);
    await nothingWritten(ev.refused);
  });

  await check("noCatalogueOrNoTranscriptAsBefore", async () => {
    // Park B has no catalogue (park group B's one package is sold at its other park): the
    // ruling message alone, as SCRUM-660 read it — the family's lines are never read, so no
    // value in the preview is the family's unmarked — and no review.
    const beforeB = modelCalls.length;
    const b = await fill(ev.b, "b");
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.review, undefined);
    const bCalls = modelCalls.slice(beforeB);
    assert.equal(bCalls.length, 1, "one read, as before");
    assert.ok(bCalls[0]!.user.endsWith(CONVERSATIONS.en[3]!.text), "the ruling message");
    assert.ok(!bCalls[0]!.user.includes("#1 [") && !bCalls[0]!.user.includes(CONVERSATIONS.en[0]!.text), "and nothing else");
    assert.ok(!bCalls[0]!.system.includes("THE PARK'S CATALOGUE") && !bCalls[0]!.system.includes("THE CONVERSATION"));
    assert.equal(b.body.source.body, CONVERSATIONS.en[3]!.text, "the preview's 'message read' is what was read");
    const [bRow] = await q("select summary_text from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1", [`%${ev.b}%`]);
    assert.equal(bRow?.summary_text, `AI Fill read the inbox confirmation message for the BEO of "ZZ TEST 815 B"`);
    // A platform answer with no transcript: the ruling message alone, as before; with the catalogue, every value the team's.
    const before = modelCalls.length;
    const plain = await fill(ev.noTranscript);
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(modelCalls.length, before + 1, "one read");
    const call = modelCalls[before]!;
    assert.ok(call.user.endsWith(CONVERSATIONS.en[3]!.text), "the ruling message, unnumbered");
    assert.ok(!call.user.includes("#1 ["));
    assert.ok(!call.system.includes("THE CONVERSATION"));
    assert.equal(plain.body.review.transcript.lines, 1);
    assert.deepEqual(plain.body.review.proposal.entertainment.find((e: any) => e.templateId === cat.face)?.from, { source: "team", at: at(3), line: null });
  });

  await check("theTeamWinsForEveryList", async () => {
    // The same add-on, dish, entertainment and set-menu choice named by the family and by the
    // team: the team's value and source, whichever line came first; two of the team's: the later.
    const catalogue = await loadBeoCatalogue(db, { tenantId: tenantA, branchId: park });
    const p = resolveCatalogueAnswer(
      {
        package: { templateId: cat.floresta, line: 4 },
        addOns: [
          { lineId: cat.reservedTable, said: "two adult tables", quantity: 2, line: 1 },
          { lineId: cat.reservedTable, said: "one table confirmed", quantity: 1, line: 4 },
          { lineId: cat.balloons, said: "balloons as agreed", quantity: 1, line: 2 },
          { lineId: cat.balloons, said: "three balloon sets", quantity: 3, line: 3 },
        ],
        setMenu: {
          templateId: cat.setMenu,
          line: 4,
          choices: [
            { itemId: PIZZA, option: "Hawaiian", said: "hawaiian after all", line: 3 },
            { itemId: PIZZA, option: "Margherita", said: "margherita", line: 2 },
          ],
        },
        menuLines: [
          { productCode: "CF-11", itemName: "two fries", menu: "kids", quantity: 2, line: 1 },
          { productCode: "cf-11", itemName: "fries", menu: "kids", quantity: 1, line: 4 },
          { productCode: "CF-11", itemName: "fries for the adults", menu: "adults", quantity: 1, line: 3 },
        ],
        entertainment: [
          { templateId: cat.bubble, said: "a long bubble show", quantity: 2, line: 1 },
          { templateId: cat.bubble, said: "bubble show", quantity: 1, line: 2 },
          { templateId: cat.zombie, said: "zombie game", line: 2 },
          { templateId: cat.zombie, said: "zombie game twice", quantity: 2, line: 4 },
        ],
      },
      catalogue,
      REFS,
    );
    const team = (line: number) => ({ source: "team", at: at(line - 1), line });
    const family = (line: number) => ({ source: "family", at: at(line - 1), line });
    assert.deepEqual(p.addOns.map((a) => [a.lineId, a.quantity, a.said, a.from]), [
      [cat.reservedTable, 1, "one table confirmed", team(4)],
      [cat.balloons, 1, "balloons as agreed", team(2)],
    ], "an add-on: the team's quantity and source, before or after the family's");
    assert.deepEqual(p.setMenu?.choices.map((c) => [c.itemId, c.option, c.from]), [[PIZZA, "Margherita", team(2)]], "a choice: the team's over a later family line");
    assert.deepEqual(p.menuLines.map((l) => [l.menu, l.productCode, l.quantity, l.itemName, l.from]), [
      ["kids", "CF-11", 1, "fries", team(4)],
      ["adults", "CF-11", 1, "fries for the adults", family(3)],
    ], "a dish: one line per list, the team's");
    assert.deepEqual(p.entertainment.map((e) => [e.templateId, e.quantity, e.said, e.from]), [
      [cat.bubble, 1, "bubble show", team(2)],
      [cat.zombie, 2, "zombie game twice", team(4)],
    ], "entertainment: the team's; of two team lines, the later");
  });

  await check("sourcesAreTheLinesNeverTheModel", async () => {
    const catalogue = await loadBeoCatalogue(db, { tenantId: tenantA, branchId: park });
    const claimed = { entertainment: [{ templateId: cat.zombie, line: 99, source: "team" }, { templateId: cat.bubble, source: "team" }] };
    const sourcesOf = (refs: TranscriptRef[], fallback?: { source: "team"; at: string; line: null }) =>
      resolveCatalogueAnswer(claimed, catalogue, refs, fallback).entertainment.map((e) => e.from);
    // In a conversation, a line the transcript does not hold (or none) is the family's: a default to check.
    assert.deepEqual(sourcesOf(REFS), [{ source: "family", at: null, line: null }, { source: "family", at: null, line: null }]);
    // The ruling message read alone: the team's.
    assert.deepEqual(sourcesOf([], { source: "team", at: at(3), line: null }), [
      { source: "team", at: at(3), line: null }, { source: "team", at: at(3), line: null },
    ]);
    // A transcript holding only the ruling message: that line's.
    assert.deepEqual(sourcesOf([{ line: 1, id: "r", source: "team", at: at(3), ruling: true }]), [
      { source: "team", at: at(3), line: 1 }, { source: "team", at: at(3), line: 1 },
    ]);
    // Neither a line nor a ruling: the family's, whatever the model claims.
    assert.deepEqual(sourcesOf([]), [{ source: "family", at: null, line: null }, { source: "family", at: null, line: null }]);
  });

  await check("aGroupOfSeveralChoicesKeepsThemAll", async () => {
    const res = await fill(ev.multi);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(review.proposal.setMenu?.choices.map((c) => [c.itemId, c.option, c.from.source, c.from.line]), [
      [PIZZA, "Margherita", "team", 2],
      [DRINKS, "Juice", "team", 2],
      [DRINKS, "Mors", "team", 2],
    ], "both drinks, the family's juice taken over by the team's line");
    const state = initialReviewState(review, { fill: res.body.fill, bookedDate: BOOKED });
    assert.deepEqual(state.choices[DRINKS]?.value, ["Juice", "Mors"]);
    assert.deepEqual(state.choices[PIZZA]?.value, ["Margherita"]);
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state, onChange: () => undefined }));
    assert.ok(html.includes(`data-testid="checkboxes-ai-review-choice-${DRINKS}"`), "a group of several is ticked, not selected");
    assert.equal(html.match(new RegExp(`data-testid="checkbox-ai-review-choice-${DRINKS}"`, "g"))?.length, 3, "one box per option");
    assert.equal(html.match(new RegExp(`data-testid="checkbox-ai-review-choice-${DRINKS}" checked=""`, "g"))?.length, 2, "both proposed drinks ticked");
    assert.ok(html.includes(`data-testid="select-ai-review-choice-${PIZZA}"`), "a group of one stays a select");
    assert.ok(html.includes("juice → Juice (CF-50)") && html.includes("mors → Mors (CF-51)"));
    assert.ok(html.includes('data-testid="text-ai-review-date-same"'), "the booked day: no tick");
    const body = approveBodyOf(review, state, { conversationId: conv.multi, messageId: res.body.source.messageId });
    assert.deepEqual(body.setMenu?.choices, [{ itemId: PIZZA, options: ["Margherita"] }, { itemId: DRINKS, options: ["Juice", "Mors"] }]);
    const approved = await approve(ev.multi, body);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const rows = await beoRows(ev.multi);
    assert.deepEqual(rows.selection.selections, [{ groupId: PIZZA, chosenOptions: ["Margherita"] }, { groupId: DRINKS, chosenOptions: ["Juice", "Mors"] }]);
    assert.deepEqual(setMenuLinesOf(rows.kitchen), byMenuOrder([
      ["Margherita", PIZZA], ["Juice", DRINKS], ["Mors", DRINKS], ["French fries", "item_cf_bday_fries"], ["Fruit skewers", "item_cf_bday_fruit_skewers"],
    ]), "both drinks reach the kitchen plan");
  });

  await check("theParentLinksChoicesAreKeptOrReset", async () => {
    // The family chose through the parent link; the kitchen plan holds their lines and one of the team's own.
    const stored = [
      { groupId: PIZZA, chosenOptions: ["Hawaiian"] },
      { groupId: HOT_DISH, chosenOptions: ["Fish fingers"] },
      { groupId: DRINKS, chosenOptions: ["Cola"] },
    ];
    const token = `zz-815-parent-${run}`;
    await q("insert into beo_set_menu_selections (event_id, template_id, token, is_submitted, submitted_at, selections) values ($1, $2, $3, true, now(), $4)", [
      ev.parent, cat.setMenu, token, JSON.stringify(stored),
    ]);
    const extra = { id: "zz-extra", itemName: "ZZ extra", quantity: 1, notes: "", included: false, price: 0, source: "additional" };
    const lines = [...resolveSetMenuLines(setMenuItems, stored), extra];
    await q("insert into beo_kitchen_plans (event_id, set_menu_enabled, set_menu_template_id, menus, simplified_menus) values ($1, true, $2, $3, $3)", [
      ev.parent, cat.setMenu, JSON.stringify({ kids: lines, adults: [] }),
    ]);
    const parentLines = byMenuOrder([
      ["Hawaiian", PIZZA], ["Fish fingers", HOT_DISH], ["Cola", DRINKS], ["French fries", "item_cf_bday_fries"], ["Fruit skewers", "item_cf_bday_fruit_skewers"],
    ]);

    // The review knows the family's choices, and says a group it leaves unchosen keeps them.
    const res = await fill(ev.parent);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review: BeoAiReview = res.body.review;
    assert.deepEqual(review.parentSelection, { templateId: cat.setMenu, choices: stored.map((s) => ({ itemId: s.groupId, options: s.chosenOptions })) });
    const html = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review, state: initialReviewState(review), onChange: () => undefined }));
    assert.ok(html.includes('data-testid="text-ai-review-parent-choice"') && html.includes("Fish fingers"), "the hot dish the family chose is named");

    // An approval with no choices on that set menu keeps the family's lines and leaves their selection as it was.
    assert.equal((await approve(ev.parent, setMenuOnly({ templateId: cat.setMenu, choices: [] }))).status, 200);
    let rows = await beoRows(ev.parent);
    assert.deepEqual(setMenuLinesOf(rows.kitchen), parentLines, "the family's set-menu lines stay");
    assert.ok((rows.kitchen.menus.kids as any[]).some((l) => l.itemName === "ZZ extra"), "the team's own line stays");
    assert.equal(rows.selection.is_submitted, true);
    assert.equal(rows.selection.token, token, "the family's link is untouched");
    assert.deepEqual(rows.selection.selections, stored);

    // A choice the review makes replaces that group only.
    assert.equal((await approve(ev.parent, setMenuOnly({ templateId: cat.setMenu, choices: [{ itemId: PIZZA, options: ["Margherita"] }] }))).status, 200);
    rows = await beoRows(ev.parent);
    assert.deepEqual(setMenuLinesOf(rows.kitchen), byMenuOrder([
      ["Margherita", PIZZA], ["Fish fingers", HOT_DISH], ["Cola", DRINKS], ["French fries", "item_cf_bday_fries"], ["Fruit skewers", "item_cf_bday_fruit_skewers"],
    ]));
    assert.deepEqual(rows.selection.selections, [stored[1], stored[2], { groupId: PIZZA, chosenOptions: ["Margherita"] }]);
    assert.equal(rows.selection.is_submitted, true);
    assert.equal(rows.selection.token, token, "the same set menu keeps the family's link");

    // Another set menu: the link starts again for it, as Reset Selections does; its own lines are written.
    assert.equal((await approve(ev.parent, setMenuOnly({ templateId: cat.setMenu2, choices: [] }))).status, 200);
    rows = await beoRows(ev.parent);
    assert.equal(rows.kitchen.set_menu_template_id, cat.setMenu2);
    assert.deepEqual(setMenuLinesOf(rows.kitchen), [["Juice jug", "item_light_jug"]], "the new set menu's included lines");
    assert.ok((rows.kitchen.menus.kids as any[]).some((l) => l.itemName === "ZZ extra"));
    assert.equal(rows.selection.template_id, cat.setMenu2);
    assert.equal(rows.selection.is_submitted, false, "the BEO no longer says the choices were received");
    assert.equal(rows.selection.selections, null);
    assert.notEqual(rows.selection.token, token, "a new link");
  });

  await check("transcriptAndResolverUnits", async () => {
    // The ruling message the bounds left out goes back in its place; a long conversation loses its oldest lines first.
    const lines = transcriptOf("en", msgIds.en).slice(0, 3);
    const r = renderTranscript(lines, { id: "ruling-1", body: "The ruling", at: at(5) }, "Asia/Bangkok");
    assert.ok(r.text.endsWith("#4 [team, RULING] 2026-11-03 14:35: The ruling"));
    // The park's clock is SCRUM-814's: another zone reads another local time; an unknown zone, the parks' own.
    assert.ok(renderTranscript(lines, { id: "ruling-1", body: "x", at: at(5) }, "Europe/Moscow").text.endsWith("#4 [team, RULING] 2026-11-03 10:35: x"));
    assert.ok(renderTranscript(lines, { id: "ruling-1", body: "x", at: at(5) }, "Not/AZone").text.endsWith("#4 [team, RULING] 2026-11-03 14:35: x"));
    const long = Array.from({ length: 60 }, (_, i) => ({ id: `l${i}`, author: "customer" as const, at: at(i), text: "x".repeat(1000) }));
    const cut = renderTranscript(long, { id: "l59", body: "", at: at(59) }, "Asia/Bangkok");
    assert.equal(cut.cut, true);
    assert.ok(cut.refs.at(-1)!.ruling, "the ruling message is never cut");
    assert.ok(cut.text.length <= 40_000);
    // The set menu's lines, as the parent link has always written them (moved, not changed).
    const resolved = resolveSetMenuLines(
      [
        { id: "a", type: "always_included", label: "French Fries", qty: 3 },
        { id: "b", type: "always_included", label: "Fruit Skewers" },
        { id: "g", type: "choice_group", label: "Pizza", options: ["Margherita", "Ham and Pineapple"], qty: 2 },
        { id: "h", type: "choice_group", label: "Drinks", options: ["Juice", "Mors"], qty: 4, allowMultiple: true },
      ],
      [{ groupId: "g", chosenOptions: ["Ham and Pineapple"] }, { groupId: "h", chosenOptions: ["Juice", "Mors"] }],
    );
    assert.deepEqual(resolved.map((l) => [l.id, l.itemName, l.quantity, l.notes, l.groupId, l.source, l.included, l.price]), [
      ["set_a", "French Fries", 3, "", "a", "set_menu", true, 0],
      ["set_b", "Fruit Skewers", 1, "", "b", "set_menu", true, 0],
      ["set_g_Ham_and_Pineapple", "Ham and Pineapple", 2, "(Pizza)", "g", "set_menu", true, 0],
      ["set_h_Juice", "Juice", 1, "(Drinks)", "h", "set_menu", true, 0],
      ["set_h_Mors", "Mors", 1, "(Drinks)", "h", "set_menu", true, 0],
    ]);
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const all = [tenantA, tenantB];
  const events = Object.values(ev);
  await q("delete from activity_log where tenant_id = any($1::uuid[])", [all]).catch(() => undefined);
  await q("delete from beo_timeline_items where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from beo_set_menu_selections where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = any($1::uuid[])", [all]).catch(() => undefined);
  await q("delete from package_line_item_templates where package_template_id = any($1::uuid[])", [[cat.floresta, cat.otherPackage]]).catch(() => undefined);
  await q("delete from birthday_package_templates where tenant_id = any($1::uuid[])", [all]).catch(() => undefined);
  await q("delete from entertainment_package_templates where tenant_id = any($1::uuid[])", [all]).catch(() => undefined);
  await q("delete from beo_set_menu_templates where tenant_id = any($1::uuid[])", [all]).catch(() => undefined);
  await q("delete from users where id = any($1::varchar[])", [Object.values(user)]).catch(() => undefined);
  await q("delete from branches where tenant_id = any($1::uuid[])", [all]).catch(() => undefined);
  await q("delete from tenants where id = any($1::uuid[])", [all]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== CHECKS ? 1 : 0);
