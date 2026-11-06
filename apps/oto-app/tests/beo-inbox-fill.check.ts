// seed: its own — two ZZ TEST park groups, made here and removed afterwards.
// Not a Playwright file: it mounts the app's AI routes on a bare server (a
// stub model, a stub platform api) and needs a database whose otoapp schema
// the app's migrator has built.
//
// SCRUM-660 — Create BEO opens the birthday's BEO form with AI Fill run on
// the inbox conversation's confirmation message
// (`POST /api/events/:eventId/beo/ai-fill/inbox`):
//   - a Thai, an English and a Russian confirmation each come back as the
//     same preview a pasted message gets, in the message's own words, with
//     the message that was read beside it;
//   - Final Message to Parent is that message while the form's is empty; a
//     person's own is kept, and the model's text for it never comes back;
//   - the message is read from the platform as the same person, with their
//     platform session's cookie, and the platform's refusals (cannot see it,
//     not a birthday, signed out, no answer, a malformed answer) and "no
//     confirmation yet" each open the form as before with one plain line;
//   - the event is the caller's to open (the BEO form's own fence) and booked
//     from the inbox, and the platform's conversation still names it;
//   - the team a fill proposes is the event's park's real people and
//     departments only; an unmatched name is flagged, never guessed;
//   - each run writes one beo_ai_fill activity row, never the text, and the
//     log carries no text either;
//   - the saved park-group settings win over the built-in defaults on the
//     routes as registered, and a malformed answer is a plain message;
//   - the Events page's address: `&fill=inbox` asks, once, and is taken off.
//
// Run from apps/oto-app: DATABASE_URL=<migrated scratch> npx tsx tests/beo-inbox-fill.check.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-inbox-fill.check: DATABASE_URL is not set");
  process.exit(2);
}
// The boot guard's switches, as a developer's machine has them; set before the app's modules load.
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-660";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "info";

const { registerAIRoutes, INBOX_FILL_MESSAGES } = await import("../server/ai-routes");
const { AI_FILL_MESSAGES, AI_SETTING_KEYS, BUILT_IN_BEO_PARSING_ADVICE } = await import("../server/lib/aiFill");
const { DEFAULT_AI_MODEL } = await import("../server/lib/anthropic");
const { loadTeamCandidates } = await import("../server/lib/beoTeamProposals");
const { sealPlatformToken } = await import("../server/lib/platformSession");
const { db, pool: appDbPool } = await import("../server/db");
const { logger } = await import("../server/lib/logger");
const { beoEventIdFrom, beoFillFrom, withoutBeoParam } = await import("../client/src/lib/beo-deep-link");
type InboxRead = Awaited<ReturnType<typeof import("../server/lib/inboxConfirmation").readInboxConfirmation>>;
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
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

const run = randomUUID().slice(0, 8);
const tenantA = randomUUID();
const tenantB = randomUUID();
const parkA1 = randomUUID();
const parkA2 = randomUUID();
const parkB1 = randomUUID();
const user = { a: randomUUID(), b: randomUUID() };
const staff = { nok: randomUUID(), ploy: randomUUID(), bee1: randomUUID(), bee2: randomUUID(), ying: randomUUID() };
const dept = { ent: randomUUID(), kitchen: randomUUID() };
const conv = { th: randomUUID(), en: randomUUID(), ru: randomUUID(), none: randomUUID(), moved: randomUUID(), hidden: randomUUID(), bad: randomUUID() };
const ev = {
  th: randomUUID(), en: randomUUID(), ru: randomUUID(), none: randomUUID(), moved: randomUUID(), hidden: randomUUID(), bad: randomUUID(),
  plain: randomUUID(), otherPark: randomUUID(),
};

// The three confirmations a manager sends. Each carries a phrase found nowhere else.
const MESSAGES = {
  th: "ยืนยันงานวันเกิดน้องมะลิ วันเสาร์ที่ 21 มีนาคม เวลา 14.00-16.00 น. เด็ก 15 คน เมนูเด็ก: นักเก็ตไก่ พิธีกร: น้องนก TH-ONLY-660",
  en: "Confirming Emma's 6th birthday on Saturday 21 March, 14:00 to 16:00. 15 kids. Kids menu: nuggets. Host: Nok, disco with Ploy, setup by Ying. EN-ONLY-660",
  ru: "Подтверждаем день рождения Маши 21 марта в 14:00. 15 детей. Меню: наггетсы. Аниматор: Нок. RU-ONLY-660",
};
const ANSWERS: Record<string, unknown> = {
  th: {
    summary: "งานวันเกิดน้องมะลิ",
    event: { childName: "น้องมะลิ", numChildren: 15, startTime: "14.00", endTime: "16.00" },
    kitchenPlan: { kidsMenu: [{ itemName: "นักเก็ตไก่", quantity: 15 }] },
    team: { partyHost: "น้องนก" },
  },
  en: {
    summary: "Emma's 6th birthday",
    event: { childName: "Emma", numChildren: 15, startTime: "14:00", endTime: "16:00" },
    kitchenPlan: { kidsMenu: [{ itemName: "nuggets", quantity: 15 }] },
    setupPlan: { responsible: "Ying" },
    team: { partyHost: "Nok", entertainmentHost: "Ploy" },
  },
  ru: {
    summary: "День рождения Маши",
    event: { childName: "Маша", numChildren: 15, startTime: "14:00" },
    kitchenPlan: { kidsMenu: [{ itemName: "наггетсы", quantity: 15 }] },
    setupPlan: { responsible: "Entertainment" },
    team: { partyHost: "Нок" },
  },
};
const languageOf = (text: string) => (/[฀-๿]/.test(text) ? "th" : /[Ѐ-ӿ]/.test(text) ? "ru" : "en");

// --- The stub model and the stub inbox ---------------------------------------------------

const modelCalls: AiCompleteOptions[] = [];
let modelReply: (call: AiCompleteOptions) => string = (call) => JSON.stringify(ANSWERS[languageOf(call.user.split("New text to parse:").pop() ?? call.user)]);
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    modelCalls.push(call);
    return modelReply(call);
  },
};

const message = (id: string, body: string) => ({
  id, body, bodyLanguage: null, authorName: "ZZ TEST Manager", sentAt: "2026-11-05T07:30:00.000Z", createdAt: "2026-11-05T07:30:00.000Z",
});
const msgIds = { th: randomUUID(), en: randomUUID(), ru: randomUUID() };
const inboxAnswers = new Map<string, InboxRead>([
  [conv.th, { ok: true, confirmation: { conversationId: conv.th, eventId: ev.th, message: message(msgIds.th, MESSAGES.th), scanned: 3 } }],
  [conv.en, { ok: true, confirmation: { conversationId: conv.en, eventId: ev.en, message: message(msgIds.en, MESSAGES.en), scanned: 2 } }],
  [conv.ru, { ok: true, confirmation: { conversationId: conv.ru, eventId: ev.ru, message: message(msgIds.ru, MESSAGES.ru), scanned: 1 } }],
  [conv.none, { ok: true, confirmation: { conversationId: conv.none, eventId: ev.none, message: null, scanned: 4 } }],
  [conv.moved, { ok: true, confirmation: { conversationId: conv.moved, eventId: randomUUID(), message: message(randomUUID(), MESSAGES.en), scanned: 1 } }],
  [conv.hidden, { ok: false, reason: "inbox_not_visible" }],
  [conv.bad, { ok: true, confirmation: { conversationId: conv.bad, eventId: ev.bad, message: message(randomUUID(), MESSAGES.en), scanned: 1 } }],
]);
const inboxCalls: string[] = [];

/** Who the request is: a header picks the persona, as the sign-in would. */
function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const who = req.get("x-test-as");
  const persona =
    who === "b"
      ? { id: user.b, tenantId: tenantB, allowed: [parkB1] }
      : who === "a"
        ? { id: user.a, tenantId: tenantA, allowed: [parkA1] }
        : null;
  if (!persona) return res.status(401).json({ message: "Not signed in" });
  (req as any).user = { id: persona.id, tenantId: persona.tenantId, role: "manager" };
  (req as any).userWithAccess = {
    id: persona.id, tenantId: persona.tenantId, isActive: true, role: "manager", hasAllBranchesAccess: false, allowedBranchIds: persona.allowed,
  };
  (req as any).requestId = `zz-660-${run}`;
  next();
}

const servers: Server[] = [];
async function listen(app: express.Express): Promise<string> {
  const server = createHttpServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const stubbed = express();
stubbed.use(express.json({ limit: "1mb" }));
registerAIRoutes(stubbed, fakeAuth, {
  ai,
  inboxConfirmation: async (_req, conversationId) => {
    inboxCalls.push(conversationId);
    return inboxAnswers.get(conversationId) ?? { ok: false, reason: "inbox_unreachable" };
  },
});
const base = await listen(stubbed);

async function post(path: string, body: unknown, as: "a" | "b" | null = "a", url = base) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(as ? { "x-test-as": as } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}
const fillFromInbox = (eventId: string, as: "a" | "b" | null = "a", url = base) =>
  post(`/api/events/${eventId}/beo/ai-fill/inbox`, { existingData: { event: { title: "ZZ TEST" } } }, as, url);

const activityRows = async (eventId: string) =>
  (
    await pool.query<{ activity_type: string; tenant_id: string; branch_id: string | null; created_by: string | null; summary_text: string; metadata_json: string }>(
      `select activity_type, tenant_id, branch_id, created_by, summary_text, metadata_json from activity_log
        where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at`,
      [`%${eventId}%`],
    )
  ).rows;

/**
 * Everything handed to the app's logger while `fn` runs, as given (before
 * redaction): outside a request context `log()` is the logger itself, and
 * `console.*` is bound to it on a deployment.
 */
async function capturingLog(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const target = logger as unknown as Record<string, (...args: unknown[]) => void>;
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const saved = levels.map((level) => target[level]!);
  levels.forEach((level, i) => {
    target[level] = (...args: unknown[]) => {
      out += `${JSON.stringify(args)}\n`;
      return saved[i]!.apply(logger, args);
    };
  });
  const consoleSaved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...args: unknown[]) => {
      out += `${JSON.stringify(args.map(String))}\n`;
    };
  }
  try {
    await fn();
  } finally {
    levels.forEach((level, i) => (target[level] = saved[i]!));
    Object.assign(console, consoleSaved);
  }
  return out;
}

try {
  // --- Two park groups: A with two parks and its people; B with saved AI settings.
  await pool.query(`insert into tenants (id, name, slug) values ($1, $2, $3), ($4, $5, $6)`, [
    tenantA, `ZZ TEST 660 A ${run}`, `zz-660-a-${run}`, tenantB, `ZZ TEST 660 B ${run}`, `zz-660-b-${run}`,
  ]);
  await pool.query(
    `insert into branches (id, tenant_id, name, address) values ($1, $2, 'ZZ TEST Park A1', 'ZZ TEST'), ($3, $2, 'ZZ TEST Park A2', 'ZZ TEST'), ($4, $5, 'ZZ TEST Park B1', 'ZZ TEST')`,
    [parkA1, tenantA, parkA2, parkB1, tenantB],
  );
  for (const [id, email] of [[user.a, `zz-660-a-${run}@example.com`], [user.b, `zz-660-b-${run}@example.com`]] as const) {
    await pool.query(
      `insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 660 Manager', 'manager', true, false)`,
      [id, email],
    );
  }
  const employee = (id: string, park: string, full: string, nick: string, thai: string | null = null) =>
    pool.query(
      `insert into employees (id, tenant_id, full_name, nickname, thai_name, email, branch_id, employment_state) values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
      [id, tenantA, full, nick, thai, `zz-660-${id.slice(0, 8)}@example.com`, park],
    );
  await employee(staff.nok, parkA1, "ZZ TEST Siriporn", "Nok", "น้องนก");
  await employee(staff.ploy, parkA1, "ZZ TEST Ploypailin", "Ploy");
  await employee(staff.bee1, parkA1, "ZZ TEST Bee One", "Bee");
  await employee(staff.bee2, parkA1, "ZZ TEST Bee Two", "Bee");
  await employee(staff.ying, parkA2, "ZZ TEST Ying", "Ying"); // the other park's
  await pool.query(`insert into departments (id, tenant_id, name) values ($1, $2, 'Entertainment'), ($3, $2, 'Kitchen')`, [dept.ent, tenantA, dept.kitchen]);
  await pool.query(`insert into department_branch_assignments (department_id, branch_id) values ($1, $2), ($3, $4)`, [dept.ent, parkA1, dept.kitchen, parkA2]);
  const event = (id: string, tenant: string, park: string, conversation: string | null, title: string) =>
    pool.query(
      `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, status, inbox_conversation_id)
       values ($1, $2, $3, 'birthday', $4, '2099-03-21', '14:00', 'tentative', $5)`,
      [id, tenant, park, title, conversation],
    );
  await event(ev.th, tenantA, parkA1, conv.th, "ZZ TEST Mali's Birthday");
  await event(ev.en, tenantA, parkA1, conv.en, "ZZ TEST Emma's 6th Birthday");
  await event(ev.ru, tenantA, parkA1, conv.ru, "ZZ TEST Masha's Birthday");
  await event(ev.none, tenantA, parkA1, conv.none, "ZZ TEST No Confirmation Yet");
  await event(ev.moved, tenantA, parkA1, conv.moved, "ZZ TEST Moved");
  await event(ev.hidden, tenantA, parkA1, conv.hidden, "ZZ TEST Hidden");
  await event(ev.bad, tenantA, parkA1, conv.bad, "ZZ TEST Bad Answer");
  await event(ev.plain, tenantA, parkA1, null, "ZZ TEST Booked By Hand");
  await event(ev.otherPark, tenantA, parkA2, conv.en, "ZZ TEST Other Park");
  await pool.query(`insert into settings (key, value, tenant_id) values ($1, 'ZZ TEST PARK B ADVICE', $3), ($2, 'gpt-4o-mini', $3)`, [
    AI_SETTING_KEYS.beoAdvice, AI_SETTING_KEYS.model, tenantB,
  ]);

  await check("thaiEnglishRussianFromTheInbox", async () => {
    for (const lang of ["th", "en", "ru"] as const) {
      const before = modelCalls.length;
      const res = await fillFromInbox(ev[lang]);
      assert.equal(res.status, 200, `${lang}: ${JSON.stringify(res.body)}`);
      // The message that was read rides beside the preview, whole.
      assert.deepEqual(res.body.source, {
        conversationId: conv[lang], messageId: msgIds[lang], body: MESSAGES[lang], authorName: "ZZ TEST Manager",
        sentAt: "2026-11-05T07:30:00.000Z", createdAt: "2026-11-05T07:30:00.000Z", fillsFinalMessage: true,
      });
      // The form's Final Message to Parent was empty: the message goes there as read.
      assert.equal(res.body.fill.event.internalStaffNotes, MESSAGES[lang], `${lang}: the final message, word for word`);
      assert.equal(modelCalls.length, before + 1, `${lang}: one model call`);
      const call = modelCalls.at(-1)!;
      assert.ok(call.user.includes(MESSAGES[lang]), `${lang}: the model reads the message`);
      assert.ok(call.user.includes('"title": "ZZ TEST"'), `${lang}: the form's state is the baseline`);
      assert.ok(call.system.startsWith(BUILT_IN_BEO_PARSING_ADVICE), `${lang}: no setting, the built-in advice`);
      assert.equal(call.model, DEFAULT_AI_MODEL);
    }
    const th = (await fillFromInbox(ev.th)).body.fill;
    assert.equal(th.event.childName, "น้องมะลิ");
    assert.equal(th.event.startTime, "14:00");
    assert.equal(th.kitchenPlan.kidsMenu[0].itemName, "นักเก็ตไก่");
    const ru = (await fillFromInbox(ev.ru)).body.fill;
    assert.equal(ru.event.childName, "Маша");
    assert.equal(ru.kitchenPlan.kidsMenu[0].itemName, "наггетсы");
  });

  await check("personsFinalMessageIsKept", async () => {
    // The model answers the built-in output format's "internalStaffNotes" key with staff notes of its own.
    const MODEL_NOTES = "ZZ TEST MODEL-STAFF-NOTES-660";
    const was = modelReply;
    modelReply = () => {
      const answer = ANSWERS.en as { event: Record<string, unknown> };
      return JSON.stringify({ ...answer, event: { ...answer.event, internalStaffNotes: MODEL_NOTES } });
    };
    try {
      // A person already put the parent's final message in the form: it is kept, and the
      // model's text for that field is not in the answer, so Load into Editor cannot apply it.
      const kept = await post(`/api/events/${ev.en}/beo/ai-fill/inbox`, { existingData: { event: { internalStaffNotes: "A person's own note" } } });
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      assert.equal(kept.body.source.fillsFinalMessage, false);
      assert.ok(!("internalStaffNotes" in kept.body.fill.event), JSON.stringify(kept.body.fill.event));
      assert.ok(!JSON.stringify(kept.body.fill).includes(MODEL_NOTES), "the model's notes never reach the screen");
      assert.equal(kept.body.fill.event.childName, "Emma", "the rest of the event section stands");
      // The form's final message is empty: the message that was read, word for word, wins over the model's text.
      const filled = await fillFromInbox(ev.en);
      assert.equal(filled.status, 200);
      assert.equal(filled.body.source.fillsFinalMessage, true);
      assert.equal(filled.body.fill.event.internalStaffNotes, MESSAGES.en);
      assert.ok(!JSON.stringify(filled.body.fill).includes(MODEL_NOTES));
    } finally {
      modelReply = was;
    }
  });

  await check("teamProposedFromTheParksPeopleOnly", async () => {
    const en = (await fillFromInbox(ev.en)).body.fill.proposals;
    assert.deepEqual(en.partyHost, { asked: "Nok", match: { kind: "employee", id: staff.nok, label: "Nok (ZZ TEST Siriporn)" }, why: null });
    assert.equal(en.entertainmentHost.match.id, staff.ploy);
    // Ying works at the other park: named, but not proposed.
    assert.deepEqual(en.setupResponsible, { asked: "Ying", match: null, why: "no_match" });
    const th = (await fillFromInbox(ev.th)).body.fill.proposals;
    assert.equal(th.partyHost.match.id, staff.nok, "the Thai name is the same person");
    const ru = (await fillFromInbox(ev.ru)).body.fill.proposals;
    assert.deepEqual(ru.partyHost, { asked: "Нок", match: null, why: "no_match" }, "no name in Cyrillic: flagged, not guessed");
    assert.deepEqual(ru.setupResponsible.match, { kind: "department", id: dept.ent, label: "Entertainment (Dept)" });
    // The candidates themselves: park A1's people and departments only.
    const candidates = await loadTeamCandidates(db, { tenantId: tenantA, branchId: parkA1 });
    assert.deepEqual(candidates.employees.map((c) => c.id).sort(), [staff.nok, staff.ploy, staff.bee1, staff.bee2].sort());
    assert.deepEqual(candidates.departments.map((d) => d.id), [dept.ent]);
    assert.equal(candidates.hostSource, "employee");
    assert.equal((await loadTeamCandidates(db, { tenantId: tenantB, branchId: parkB1 })).hostSource, "user");
  });

  await check("noConfirmationOpensAsBefore", async () => {
    const before = modelCalls.length;
    const res = await fillFromInbox(ev.none);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { reason: "no_confirmation", message: INBOX_FILL_MESSAGES.no_confirmation });
    assert.equal(modelCalls.length, before, "no message, no model call");
    assert.equal((await activityRows(ev.none)).length, 0, "nothing ran, nothing logged as a fill");
  });

  await check("eventMustBeTheCallersAndFromTheInbox", async () => {
    const calls = inboxCalls.length;
    // Booked by hand: no conversation to read.
    assert.deepEqual((await fillFromInbox(ev.plain)).body, { reason: "not_from_inbox", message: INBOX_FILL_MESSAGES.not_from_inbox });
    // A park this manager does not reach, another park group's event, no sign-in: the form's own fence.
    assert.equal((await fillFromInbox(ev.otherPark)).status, 404);
    assert.equal((await fillFromInbox(ev.en, "b")).status, 404);
    assert.equal((await fillFromInbox(ev.en, null)).status, 401);
    assert.equal((await fillFromInbox("not-an-id")).status, 404);
    assert.equal(inboxCalls.length, calls, "the inbox is never asked for an event the caller cannot open");
    // The conversation now names another event.
    assert.deepEqual((await fillFromInbox(ev.moved)).body, { reason: "event_mismatch", message: INBOX_FILL_MESSAGES.event_mismatch });
    // The inbox says this person cannot see the conversation.
    const hidden = await fillFromInbox(ev.hidden);
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, { reason: "inbox_not_visible", message: INBOX_FILL_MESSAGES.inbox_not_visible });
  });

  await check("malformedAnswerIsAPlainMessage", async () => {
    const was = modelReply;
    modelReply = () => "I could not find a birthday here.";
    try {
      const res = await fillFromInbox(ev.bad);
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { reason: "unreadable", message: AI_FILL_MESSAGES.unreadable });
      assert.equal(res.body.fill, undefined, "nothing to apply");
      const rows = await activityRows(ev.bad);
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(rows[0]!.metadata_json).outcome, "unreadable");
    } finally {
      modelReply = was;
    }
  });

  await check("activityRowsCarryNoText", async () => {
    const rows = await activityRows(ev.en);
    assert.ok(rows.length >= 1);
    const row = rows[0]!;
    assert.equal(row.tenant_id, tenantA);
    assert.equal(row.branch_id, parkA1);
    assert.equal(row.created_by, user.a);
    assert.equal(row.summary_text, `AI Fill read the inbox confirmation message for the BEO of "ZZ TEST Emma's 6th Birthday"`);
    const meta = JSON.parse(row.metadata_json);
    assert.equal(meta.source, "inbox");
    assert.equal(meta.inboxConversationId, conv.en);
    assert.equal(meta.inboxMessageId, msgIds.en);
    assert.equal(meta.outcome, "filled");
    assert.equal(meta.inputChars, MESSAGES.en.length);
    assert.deepEqual(meta.team, { named: 3, matched: 2 });
    for (const lang of ["th", "en", "ru"] as const) {
      for (const r of await activityRows(ev[lang])) {
        const all = r.summary_text + r.metadata_json;
        for (const phrase of [`${lang.toUpperCase()}-ONLY-660`, "nuggets", "นักเก็ตไก่", "наггетсы", "Host: Nok"]) {
          assert.ok(!all.includes(phrase), `${lang}: the activity row carries no "${phrase}"`);
        }
      }
    }
  });

  await check("logCarriesNoText", async () => {
    const out = await capturingLog(async () => {
      assert.equal((await fillFromInbox(ev.en)).status, 200);
      assert.equal((await post("/api/ai/parse-beo", { text: MESSAGES.ru, eventId: ev.ru })).status, 200);
    });
    assert.match(out, /ai fill run/, "the run is logged");
    for (const phrase of ["EN-ONLY-660", "RU-ONLY-660", "nuggets", "наггетсы", "Emma", BUILT_IN_BEO_PARSING_ADVICE.slice(0, 30)]) {
      assert.ok(!out.includes(phrase), `the log carries no "${phrase}"`);
    }
  });

  await check("pastedMessageWithTheEvent", async () => {
    const res = await post("/api/ai/parse-beo", { text: MESSAGES.en, eventId: ev.en });
    assert.equal(res.status, 200);
    assert.equal(res.body.event.childName, "Emma");
    assert.equal(res.body.proposals.partyHost.match.id, staff.nok);
    const rows = (await activityRows(ev.en)).map((r) => JSON.parse(r.metadata_json));
    assert.ok(rows.some((m) => m.source === "pasted" && m.outcome === "filled"));
    // An event the caller cannot open is refused before anything is read.
    const calls = modelCalls.length;
    assert.equal((await post("/api/ai/parse-beo", { text: MESSAGES.en, eventId: ev.otherPark })).status, 404);
    assert.equal(modelCalls.length, calls);
    // A body off its shape is refused before anything is read.
    assert.equal((await post("/api/ai/parse-beo", { text: MESSAGES.en, existingData: "the form" })).status, 400);
    assert.equal((await post(`/api/events/${ev.en}/beo/ai-fill/inbox`, { existingData: [1, 2] })).status, 400);
    assert.equal(modelCalls.length, calls, "no model call for a refused body");
    // Without an event: the fill, and no team to propose.
    const bare = await post("/api/ai/parse-beo", { text: MESSAGES.en });
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.body.proposals, { partyHost: null, entertainmentHost: null, setupResponsible: null });
  });

  await check("savedSettingWinsOnTheRoutes", async () => {
    const calls = modelCalls.length;
    const res = await post("/api/ai/parse-beo", { text: MESSAGES.en }, "b");
    assert.equal(res.status, 200);
    const call = modelCalls[calls]!;
    assert.ok(call.system.startsWith("ZZ TEST PARK B ADVICE"), "park group B's saved advice");
    assert.equal(call.model, DEFAULT_AI_MODEL, "its saved OpenAI model name is not sent");
    // Park group A, with nothing saved, still runs on the built-ins.
    await post("/api/ai/parse-beo", { text: MESSAGES.en }, "a");
    assert.ok(modelCalls.at(-1)!.system.startsWith(BUILT_IN_BEO_PARSING_ADVICE));
  });

  await check("readsThePlatformAsThePerson", async () => {
    // The real reader, against a stand-in platform api that checks the person's cookie.
    const token = `zz-660-token-${run}`;
    const sessionId = `zz-660-session-${run}`;
    const seen: Array<{ path: string; cookie: string | undefined }> = [];
    const platform = express();
    platform.get("/inbox/conversations/:id/beo-confirmation", (req, res) => {
      seen.push({ path: req.path, cookie: req.get("cookie") });
      if (req.get("cookie") !== `oto_session=${token}`) return res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
      const id = req.params.id;
      if (id === conv.en) return res.json({ conversationId: id, eventId: ev.en, message: message(msgIds.en, MESSAGES.en), scanned: 1 });
      if (id === conv.hidden) return res.status(404).json({ error: { code: "NOT_FOUND" } });
      if (id === conv.none) return res.status(409).json({ error: { code: "NOT_A_BIRTHDAY" } });
      if (id === conv.bad) return res.json({ conversationId: id, message: "not the shape" });
      return res.status(500).json({ error: { code: "INTERNAL" } });
    });
    const platformUrl = await listen(platform);
    process.env.PLATFORM_API_URL = platformUrl;
    process.env.OTOAPP_PUBLIC_ORIGIN = "http://127.0.0.1";
    const sealed = sealPlatformToken(process.env.SESSION_SECRET!, sessionId, token);
    // A platform session the platform has since ended: its token no longer opens anything there.
    const ended = sealPlatformToken(process.env.SESSION_SECRET!, sessionId, `${token}-ended`);
    const real = express();
    real.use(express.json());
    real.use((req, _res, next) => {
      const which = req.get("x-test-platform");
      if (which === "yes" || which === "ended") {
        (req as any).session = { platform: { accountId: randomUUID(), sealedToken: which === "yes" ? sealed : ended } };
        (req as any).sessionID = sessionId;
      }
      next();
    });
    registerAIRoutes(real, fakeAuth, { ai });
    const realUrl = await listen(real);
    const call = async (eventId: string, platformSession: boolean | "ended") => {
      const header = platformSession === "ended" ? "ended" : platformSession ? "yes" : null;
      const response = await fetch(`${realUrl}/api/events/${eventId}/beo/ai-fill/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-as": "a", ...(header ? { "x-test-platform": header } : {}) },
        body: "{}",
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
    const ok = await call(ev.en, true);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.source.body, MESSAGES.en);
    assert.deepEqual(seen.at(-1), { path: `/inbox/conversations/${conv.en}/beo-confirmation`, cookie: `oto_session=${token}` });
    assert.equal((await call(ev.hidden, true)).body.reason, "inbox_not_visible");
    assert.equal((await call(ev.none, true)).body.reason, "not_a_birthday");
    assert.equal((await call(ev.bad, true)).body.reason, "inbox_unreachable", "a malformed answer is not read");
    assert.equal((await call(ev.th, true)).body.reason, "inbox_unreachable", "a 500 is no answer");
    const signedOut = await call(ev.en, "ended");
    assert.equal(signedOut.status, 401);
    assert.deepEqual(signedOut.body, { reason: "signed_out", message: INBOX_FILL_MESSAGES.signed_out });
    // A session not opened from the launcher has no platform session to read with.
    const before = seen.length;
    const legacy = await call(ev.en, false);
    assert.equal(legacy.status, 409);
    assert.deepEqual(legacy.body, { reason: "no_platform_session", message: INBOX_FILL_MESSAGES.no_platform_session });
    assert.equal(seen.length, before, "nothing is asked without the person's own session");
    // The token is never in an answer.
    assert.ok(!JSON.stringify(ok.body).includes(token));
    delete process.env.PLATFORM_API_URL;
    delete process.env.OTOAPP_PUBLIC_ORIGIN;
  });

  await check("deepLinkFill", () => {
    const id = randomUUID();
    assert.equal(beoFillFrom(`?beo=${id}&fill=inbox`), "inbox");
    assert.equal(beoEventIdFrom(`?beo=${id}&fill=inbox`), id);
    assert.equal(beoFillFrom(`?beo=${id}`), null);
    assert.equal(beoFillFrom(`?beo=${id}&fill=other`), null);
    assert.equal(beoFillFrom(`?beo=${id}&fill=inbox&fill=inbox`), null, "asked twice is not asked");
    assert.equal(withoutBeoParam("/studio/events/kanban", `?beo=${id}&fill=inbox`), "/studio/events/kanban");
    assert.equal(withoutBeoParam("/studio/events/kanban", `?view=list&beo=${id}&fill=inbox`), "/studio/events/kanban?view=list");
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const all = [tenantA, tenantB];
  await pool.query(`delete from activity_log where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from settings where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from core_events where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from department_branch_assignments where department_id = any($1::varchar[])`, [Object.values(dept)]).catch(() => undefined);
  await pool.query(`delete from departments where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from employees where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from users where id = any($1::varchar[])`, [Object.values(user)]).catch(() => undefined);
  await pool.query(`delete from branches where tenant_id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.query(`delete from tenants where id = any($1::uuid[])`, [all]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

console.log(JSON.stringify({ results, failures }, null, 2));
// The app's modules loaded here keep handles of their own open; the verdict is final.
process.exit(Object.values(results).some((ok) => !ok) || Object.keys(results).length !== 12 ? 1 : 0);
