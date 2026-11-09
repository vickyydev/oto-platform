// seed: its own — two ZZ TEST park groups, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes on a bare server (a
// stub model, a stub platform api) and needs a database whose otoapp schema
// the app's migrator has built. It renders the review's own component, so it
// runs with TSX_TSCONFIG_PATH=tests/tsconfig.jsx.json.
//
// SCRUM-815 — Create BEO's AI Fill reads the WHOLE conversation and matches it
// to the park's catalogue; the review shows the proposed BEO in edit mode;
// nothing is written until staff press "Approve and create".
//   - three conversations, in Russian, Thai and English, each agreeing the
//     Floresta package, a pizza choice from its set menu, one extra dish, an
//     entertainment line, and a family-only wish the team never confirmed:
//     the model (a stub) is handed the numbered conversation, the ruling
//     message marked, the conversation's rules and the catalogue with its ids;
//   - the proposal's ids are the catalogue's; each value's source is the
//     author of the line it came from (a model that calls a family line the
//     team's is corrected); the family-only wish is marked "family"; a dish
//     the catalogue lacks is a notInMenu line; an id the catalogue does not
//     hold is a free line; the chat's price rides beside the catalogue's;
//   - nothing is written by the fill (no snapshot, kitchen plan, selection,
//     entertainment, billing; the event's counts as they were);
//   - "Approve and create", with the body the review itself builds, writes the
//     package snapshot (add-on quantities), the kitchen plan (the set menu, the
//     choice as the parent link writes it, the extra dish, the free line kept),
//     the entertainment at the catalogue's prices, the counts, times and
//     deposit, and one beo_ai_fill activity row with the sources and matches
//     and none of the chat's words; an id outside the catalogue refuses the
//     whole approval and writes nothing; a staff login is refused, another
//     park group's event is not found;
//   - the review renders the BEO's sections with "from the family" / "from the
//     team" marks, "пицца Маргарита → Margherita (CF-24)", the chat's price
//     beside the catalogue's, and the notInMenu line waiting for a decision;
//   - a park with no catalogue and a platform with no transcript answer as
//     SCRUM-660 did (no review).
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
const { renderTranscript, resolveCatalogueAnswer, loadBeoCatalogue } = await import("../server/lib/beoCatalogueFill");
const { resolveSetMenuLines } = await import("../server/lib/setMenuResolve");
const { db, pool: appDbPool } = await import("../server/db");
const { initialReviewState, approveBodyOf, undecidedLines } = await import("../client/src/lib/beo-ai-review");
const { BeoAiReviewBody } = await import("../client/src/components/beo/beo-ai-review");
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;
type BeoAiReview = import("../shared/beoAiFill").BeoAiReview;

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
  reservedTable: randomUUID(),
  balloons: randomUUID(),
  kidsTable: randomUUID(),
  bubble: randomUUID(),
  face: randomUUID(),
  zombie: randomUUID(),
  otherPackage: randomUUID(), // park group B's: never matched for A
};
const ev = { ru: randomUUID(), th: randomUUID(), en: randomUUID(), junk: randomUUID(), refused: randomUUID(), b: randomUUID(), noTranscript: randomUUID() };
const conv = { ru: randomUUID(), th: randomUUID(), en: randomUUID(), junk: randomUUID(), refused: randomUUID(), b: randomUUID(), noTranscript: randomUUID() };
const PIZZA = "item_cf_bday_pizza";

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
  ru: { pkg: "пакет Флореста", pizza: "пицца Маргарита", fries: "картошка фри", sushi: "суши", bubble: "Бабл-шоу", face: "аквагрим", child: "Маша" },
  th: { pkg: "แพ็กเกจฟลอเรสต้า", pizza: "พิซซ่ามาร์การิต้า", fries: "เฟรนช์ฟรายส์", sushi: "ซูชิ", bubble: "บับเบิ้ลโชว์", face: "ระบายสีหน้า", child: "น้องมะลิ" },
  en: { pkg: "Floresta package", pizza: "Margherita pizza", fries: "extra fries", sushi: "sushi", bubble: "bubble show", face: "face painting", child: "Emma" },
};
const msgIds: Record<keyof typeof conv, string[]> = Object.fromEntries(
  Object.keys(conv).map((k) => [k, [randomUUID(), randomUUID(), randomUUID(), randomUUID()]]),
) as Record<keyof typeof conv, string[]>;
const at = (i: number) => new Date(Date.UTC(2026, 10, 3, 7, i * 7)).toISOString();
const transcriptOf = (lang: "ru" | "th" | "en", ids: string[]) => CONVERSATIONS[lang].map((l, i) => ({ id: ids[i]!, author: l.author, at: at(i), text: l.text }));

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
    event: { childName: w.child, numChildren: 12, numAdults: 6, startTime: "14:00" },
    kitchenPlan: { kidsMenu: [{ itemName: w.pizza, quantity: 1 }] },
    partyDetails: { packageName: w.pkg },
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

const modelCalls: AiCompleteOptions[] = [];
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    if (call.user.includes("JUNK-815")) return JSON.stringify(JUNK_ANSWER);
    const lang = call.user.includes("RU-815") ? "ru" : call.user.includes("TH-815") ? "th" : call.user.includes("EN-815") ? "en" : null;
    if (lang) return JSON.stringify(answerFor(lang));
    return JSON.stringify({ summary: "ZZ plain", event: { childName: "Plain" } });
  },
};

const confirmation = (key: keyof typeof conv, eventId: string, transcript: ReturnType<typeof transcriptOf>): InboxRead => {
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
const JUNK_LINES = [
  { id: msgIds.junk[0]!, author: "customer" as const, at: at(0), text: "Hi, a party please JUNK-815" },
  { id: msgIds.junk[1]!, author: "staff" as const, at: at(1), text: "Confirmed 21 November 14:00, Super Party package, four cheese pizza, dragon fruit, magic show 3,000, 12 kids" },
];
const inbox = new Map<string, InboxRead>([
  [conv.ru, confirmation("ru", ev.ru, transcriptOf("ru", msgIds.ru))],
  [conv.th, confirmation("th", ev.th, transcriptOf("th", msgIds.th))],
  [conv.en, confirmation("en", ev.en, transcriptOf("en", msgIds.en))],
  [conv.refused, confirmation("refused", ev.refused, transcriptOf("en", msgIds.refused))],
  [conv.junk, confirmation("junk", ev.junk, JUNK_LINES)],
  [conv.b, confirmation("b", ev.b, transcriptOf("en", msgIds.b))],
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
registerAIRoutes(app, fakeAuth, {
  ai,
  inboxConfirmation: async (_req, conversationId) => inbox.get(conversationId) ?? { ok: false, reason: "inbox_unreachable" },
});
const server = createHttpServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function post(path: string, body: unknown, as: "manager" | "staff" | "b" | null = "manager") {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(as ? { "x-test-as": as } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const fill = (eventId: string, as: "manager" | "b" = "manager") => post(`/api/events/${eventId}/beo/ai-fill/inbox`, { existingData: { event: { title: "ZZ TEST" } } }, as);
const approve = (eventId: string, body: unknown, as: "manager" | "staff" | "b" = "manager") => post(`/api/events/${eventId}/beo/ai-fill/approve`, body, as);

/** What the BEO holds: every table an approval writes. */
async function beoRows(eventId: string) {
  const [event] = await q("select num_children, num_adults, start_time, end_time, child_name, special_requests, internal_staff_notes from core_events where id = $1", [eventId]);
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
  return rows;
};

const reviews: Partial<Record<"ru" | "th" | "en", BeoAiReview>> = {};
const sources: Partial<Record<"ru" | "th" | "en", any>> = {};

try {
  // --- Park group A with the Floresta catalogue (as script/seed-birthday-packages.mjs prints it), B with none.
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
  const setMenuItems = [
    { id: PIZZA, type: "choice_group", label: "Pizza", options: ["Margherita", "Hawaiian", "Pepperoni"], allowMultiple: false, optionProductCodes: { Margherita: "CF-24", Hawaiian: "CF-27", Pepperoni: "CF-31" } },
    { id: "item_cf_bday_hot_dish", type: "choice_group", label: "Hot dish", options: ["Chicken schnitzel", "Fish fingers"], allowMultiple: false, optionProductCodes: { "Chicken schnitzel": "CF-37" } },
    { id: "item_cf_bday_fries", type: "always_included", label: "French fries", productCode: "CF-11" },
    { id: "item_cf_bday_fruit_skewers", type: "always_included", label: "Fruit skewers" },
  ];
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'Birthday set menu, Central Floresta', $3)", [cat.setMenu, tenantA, JSON.stringify(setMenuItems)]);
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
       values ($1, $2, $3, 'birthday', $4, '2099-11-21', '10:00', 'tentative', $5)`,
      [id, tenant, branch, title, conversation],
    );
  for (const k of ["ru", "th", "en", "junk", "refused", "noTranscript"] as const) await event(ev[k], tenantA, park, conv[k], `ZZ TEST 815 ${k}`);
  await event(ev.b, tenantB, parkB, conv.b, "ZZ TEST 815 B");

  await check("conversationAndCatalogueReachTheModel", async () => {
    for (const lang of ["ru", "th", "en"] as const) {
      const before = modelCalls.length;
      const res = await fill(ev[lang]);
      assert.equal(res.status, 200, `${lang}: ${JSON.stringify(res.body)}`);
      assert.equal(modelCalls.length, before + 1, `${lang}: one model call`);
      const call = modelCalls.at(-1)!;
      // The numbered conversation, oldest first, the ruling message marked, on the park's clock (UTC+7).
      assert.ok(call.user.includes(`#1 [family] 2026-11-03 14:00: ${CONVERSATIONS[lang][0]!.text}`), `${lang}: line 1 is the family's`);
      assert.ok(call.user.includes(`#2 [team] 2026-11-03 14:07: `), `${lang}: line 2 is the team's`);
      assert.ok(call.user.includes(`#4 [team, RULING] 2026-11-03 14:21: ${CONVERSATIONS[lang][3]!.text}`), `${lang}: the ruling line`);
      // The conversation's rules and the catalogue, with its ids, codes and prices in baht.
      for (const piece of ["THE CONVERSATION", "The team's confirmation wins", "The family's values are the defaults", "THE PARK'S CATALOGUE", cat.floresta, cat.reservedTable, cat.setMenu, PIZZA, cat.bubble, '"CF-24"', '"priceWeekday":16900', '"catalogue": {', "Never invent an item", "never price or total anything"]) {
        assert.ok(call.system.includes(piece), `${lang}: the system prompt carries ${piece}`);
      }
      // Another park group's package is never offered.
      assert.ok(!call.system.includes(cat.otherPackage), `${lang}: B's package is not in A's catalogue`);
      reviews[lang] = res.body.review;
      sources[lang] = res.body.source;
      assert.ok(res.body.review, `${lang}: a review`);
      assert.deepEqual(res.body.review.transcript, { lines: 4, cut: false });
      assert.equal(res.body.review.finalMessage, CONVERSATIONS[lang][3]!.text, `${lang}: Final Message to Parent is the ruling message`);
      // The free-text fill of before still rides beside it, for Load into Editor.
      assert.equal(res.body.fill.event.childName, WORDS[lang].child);
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
    // The catalogue the review shows: A's park only, with its set menu's food codes.
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
      assert.deepEqual(meta.catalogue, { package: true, addOns: lang === "ru" ? 1 : 0, setMenu: true, choices: 1, menuLines: 1, notInMenu: 1, entertainment: 2, notInCatalogue: 0 });
      for (const word of Object.values(WORDS[lang])) assert.ok(!rows.activity[0]!.metadata_json.includes(word), `${lang}: no "${word}" in the activity row`);
    }
  });

  await check("reviewRendersSourcesMatchesAndPrices", () => {
    const review = reviews.ru!;
    const state = initialReviewState(review);
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
    for (const lang of ["th", "en"] as const) {
      const other = renderToStaticMarkup(React.createElement(BeoAiReviewBody, { review: reviews[lang]!, state: initialReviewState(reviews[lang]!), onChange: () => undefined }));
      assert.ok(other.includes(`${WORDS[lang].pizza} → Margherita (CF-24)`), `${lang}: the pizza match`);
    }
  });

  await check("approvalWritesTheBeo", async () => {
    // Russian: everything as proposed, the sushi kept as a free line.
    const review = reviews.ru!;
    const state = initialReviewState(review);
    state.menuLines = state.menuLines.map((l) => (l.notInMenu ? { ...l, decision: "keep" as const } : l));
    const body = approveBodyOf(review, state, { conversationId: conv.ru, messageId: sources.ru.messageId });
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
    assert.deepEqual(kids.filter((l) => l.source === "set_menu").map((l) => [l.itemName, l.groupId]), [
      ["Margherita", PIZZA], ["French fries", "item_cf_bday_fries"], ["Fruit skewers", "item_cf_bday_fruit_skewers"],
    ].sort((a, b) => setMenuItemsOrder(a[1]!) - setMenuItemsOrder(b[1]!)));
    const extras = kids.filter((l) => l.source !== "set_menu");
    assert.deepEqual(extras.map((l) => [l.itemName, l.notes, l.source]), [["French fries", "CF-11", "additional"], ["суши", "Not in the menu", "additional"]]);
    assert.deepEqual(rows.kitchen.simplified_menus.kids, kids);
    assert.equal(rows.kitchen.cake_mode, "INTERNAL");
    assert.equal(rows.selection.template_id, cat.setMenu);
    assert.equal(rows.selection.is_submitted, true);
    assert.deepEqual(rows.selection.selections, [{ groupId: PIZZA, chosenOptions: ["Margherita"] }]);
    // Entertainment at the catalogue's prices: the bubble show (the chat said 5,000) and the family's wish.
    assert.deepEqual(rows.entertainment.map((e) => [e.template_id, e.name, e.price]), [[cat.bubble, "Bubble show", 550000], [cat.face, "Face painting", 200000]]);
    // The counts, times, child, final message and deposit.
    assert.equal(rows.event.num_children, 12);
    assert.equal(rows.event.num_adults, 6);
    assert.equal(rows.event.start_time, "14:00");
    assert.equal(rows.event.child_name, "Маша");
    assert.equal(rows.event.internal_staff_notes, CONVERSATIONS.ru[3]!.text);
    assert.equal(rows.billing.deposit_paid, true);
    assert.equal(rows.billing.deposit_paid_amount, 5000);
    // One activity row for the approval: sources and matches, never the chat's words.
    const approved = rows.activity.map((r) => JSON.parse(r.metadata_json)).filter((m) => m.step === "approved");
    assert.equal(approved.length, 1);
    const meta = approved[0]!;
    assert.equal(meta.inboxConversationId, conv.ru);
    assert.ok(meta.sources.some((s: any) => s.field === "package" && s.source === "team"));
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

  await check("reviewerEditsAreWhatIsWritten", async () => {
    // Thai: the reviewer leaves out the family's wish and the sushi, and changes the adults.
    const review = reviews.th!;
    const state = initialReviewState(review);
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
    // Park B has no catalogue (park group B's one package is sold at its other park): the SCRUM-660 answer, no review.
    const b = await fill(ev.b, "b");
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.review, undefined);
    const bCall = modelCalls.at(-1)!;
    assert.ok(!bCall.system.includes("THE PARK'S CATALOGUE"));
    assert.ok(bCall.system.includes("THE CONVERSATION"), "a conversation is still read as one, with its rules");
    // A platform answer with no transcript: the ruling message alone, as before; with the catalogue, every value the team's.
    const before = modelCalls.length;
    const plain = await fill(ev.noTranscript);
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    const call = modelCalls[before]!;
    assert.ok(call.user.endsWith(CONVERSATIONS.en[3]!.text), "the ruling message, unnumbered");
    assert.ok(!call.user.includes("#1 ["));
    assert.ok(!call.system.includes("THE CONVERSATION"));
    assert.equal(plain.body.review.transcript.lines, 1);
  });

  await check("transcriptAndResolverUnits", async () => {
    // The ruling message the bounds left out goes back in its place; a long conversation loses its oldest lines first.
    const lines = transcriptOf("en", msgIds.en).slice(0, 3);
    const r = renderTranscript(lines, { id: "ruling-1", body: "The ruling", at: at(5) }, "Asia/Bangkok");
    assert.ok(r.text.endsWith("#4 [team, RULING] 2026-11-03 14:35: The ruling"));
    const long = Array.from({ length: 60 }, (_, i) => ({ id: `l${i}`, author: "customer" as const, at: at(i), text: "x".repeat(1000) }));
    const cut = renderTranscript(long, { id: "l59", body: "", at: at(59) }, "Asia/Bangkok");
    assert.equal(cut.cut, true);
    assert.ok(cut.refs.at(-1)!.ruling, "the ruling message is never cut");
    assert.ok(cut.text.length <= 40_000);
    // A source with no line we hold: the model's word; neither: the family's.
    const catalogue = await loadBeoCatalogue(db, { tenantId: tenantA, branchId: park });
    const p = resolveCatalogueAnswer(
      { entertainment: [{ templateId: cat.zombie, line: 99, source: "team" }, { templateId: cat.bubble }] },
      catalogue,
      [],
    );
    assert.deepEqual(p.entertainment.map((e) => e.from), [{ source: "team", at: null, line: null }, { source: "family", at: null, line: null }]);
    assert.equal(catalogue.place.timeZone, "Asia/Bangkok");
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

/** The set menu's own order of its items, which the kitchen plan's set-menu lines follow. */
function setMenuItemsOrder(id: string): number {
  return [PIZZA, "item_cf_bday_hot_dish", "item_cf_bday_fries", "item_cf_bday_fruit_skewers"].indexOf(id);
}

console.log(JSON.stringify({ results, failures }, null, 2));
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== 10 ? 1 : 0);
