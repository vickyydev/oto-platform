// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) and a
// stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built.
//
// SCRUM-825 — a party's deposit asked from the BEO through the platform, the
// server's half (the screen's is tests/party-deposit-ui.check.ts):
//
//   - the shared rules on their own: the amount (whole baht, ฿1 to
//     ฿1,000,000), satang to baht one way, the words for each state;
//   - the client asks the platform with this app's provisioning key as a
//     Bearer and the press as the Idempotency-Key, never a session, and reads
//     its answers and its refusals in words;
//   - GET /api/events/:eventId/beo/deposit-request answers the platform's
//     state for a linked party, and says why not otherwise (the park not
//     linked, this deployment without the key, the platform not answering,
//     an event the till never settles) — never a state of its own;
//   - POST …/deposit-request (a manager's press) sends the amount in satang,
//     who pressed and the party's chat to the platform, the press as the
//     Idempotency-Key; staff are refused, another park group's party is not
//     found, a party with no chat and a bad amount are refused before the
//     platform is asked; Resend and Cancel request forward the press;
//   - POST …/menu-link posts the parent's selection link built from this
//     deployment's own address and the selection's token; without a selection
//     or once the family chose, it is refused by name;
//   - the parent's public submit, once it answered 200, tells the platform
//     the choices landed — keyed by the submission — and a second submit
//     (409) tells it nothing.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/party-deposit.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { actOnPartyDeposit, postPartyMenuLink, postPartyMenuReceived, readPartyDeposit, requestPartyDeposit } from "../server/lib/partyDepositRequest";
import {
  PartyDepositAnswerSchema,
  bahtOfSatang,
  depositAmountOf,
  depositRequestProblem,
  depositStateWordsOf,
  satangOfWholeBaht,
  type PartyDepositRequest,
} from "../shared/partyDeposit";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("party-deposit.check: DATABASE_URL is not set");
  process.exit(2);
}

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const EVENT = randomUUID();
function request(state: PartyDepositRequest["state"], over: Partial<PartyDepositRequest> = {}): PartyDepositRequest {
  return {
    id: randomUUID(),
    eventId: EVENT,
    conversationId: randomUUID(),
    amountSatang: 300_000,
    currency: "THB",
    state,
    paymentLink: state === "requested" ? "https://pay.zz-test.example/hosted/abc" : null,
    linkExpiresAt: "2026-11-14T08:02:00.000Z",
    invoiceNo: "ZZ-WEB-825",
    requestedAt: "2026-11-11T08:02:00.000Z",
    remindedAt: null,
    handedOverAt: null,
    paidAt: state === "paid" ? "2026-11-11T10:00:00.000Z" : null,
    closedAt: null,
    closeReason: null,
    depositBeforeSatang: null,
    depositAfterSatang: null,
    writeBack: null,
    requestLineStatus: state === "requested" ? "sent" : null,
    ...over,
  };
}

// ─── The shared rules, on their own ──────────────────────────────────────────

await check("the amount rule: whole baht from ฿1 to ฿1,000,000; the field read; satang both ways; the words for each state", () => {
  assert.equal(depositRequestProblem(null), "Type the deposit to ask for, in baht.");
  assert.equal(depositRequestProblem(Number.NaN), "The deposit is whole baht.");
  assert.equal(depositRequestProblem(300.5), "The deposit is whole baht.");
  assert.equal(depositRequestProblem(0), "The deposit is at least ฿1.");
  assert.equal(depositRequestProblem(1_000_001), "The deposit is at most ฿1,000,000.");
  assert.equal(depositRequestProblem(3000), null);
  assert.equal(depositAmountOf(" 3,000 "), 3000);
  assert.equal(depositAmountOf(""), null);
  assert.ok(Number.isNaN(depositAmountOf("three")));
  assert.equal(satangOfWholeBaht(3000), 300_000);
  assert.equal(bahtOfSatang(300_000), "฿3,000");
  assert.equal(bahtOfSatang(12_550), "฿125.50");
  const open = depositStateWordsOf(request("requested"));
  assert.equal(open.headline, "Deposit requested · ฿3,000");
  assert.equal(open.tone, "open");
  assert.match(open.detail, /valid until 14 Nov/);
  assert.match(depositStateWordsOf(request("requested", { remindedAt: "2026-11-12T08:02:00.000Z" })).detail, /^Reminded once\./);
  const overdue = depositStateWordsOf(request("requested", { handedOverAt: "2026-11-13T08:02:00.000Z" }));
  assert.equal(overdue.headline, "Deposit overdue · ฿3,000");
  assert.equal(overdue.tone, "overdue");
  const paid = depositStateWordsOf(request("paid", { writeBack: { editId: "e", syncState: "synced", syncError: null } }));
  assert.equal(paid.headline, "Deposit paid · ฿3,000");
  assert.equal(paid.tone, "paid");
  assert.match(paid.detail, /updated here and at the till/);
  assert.match(depositStateWordsOf(request("paid", { writeBack: { editId: "e", syncState: "failed", syncError: "x" } })).detail, /still on its way/);
  assert.equal(depositStateWordsOf(request("expired")).headline, "Link expired · ฿3,000");
  assert.equal(depositStateWordsOf(request("cancelled")).headline, "Request cancelled · ฿3,000");
  assert.equal(depositStateWordsOf(request("cancelled")).tone, "closed");
  // Where the line stands: on its way, or never sent — and a page the gateway would not open.
  const queued = depositStateWordsOf(request("requested", { requestLineStatus: "queued" }));
  assert.match(queued.detail, /on its way to the family's chat, valid until 14 Nov/);
  assert.equal(queued.tone, "open");
  const unsent = depositStateWordsOf(request("requested", { requestLineStatus: "failed" }));
  assert.equal(unsent.headline, "Deposit requested · ฿3,000");
  assert.match(unsent.detail, /could not be sent to the family's chat: press Resend/);
  assert.equal(unsent.tone, "overdue");
  assert.equal(depositStateWordsOf(request("requested", { requestLineStatus: "withdrawn" })).tone, "overdue");
  assert.match(depositStateWordsOf(request("requested", { requestLineStatus: undefined })).detail, /is in the family's chat/);
  const notMade = depositStateWordsOf(request("cancelled", { closeReason: "gateway_refused" }));
  assert.equal(notMade.headline, "Request not made · ฿3,000");
  assert.match(notMade.detail, /The payment page could not be opened/);
  assert.equal(notMade.tone, "closed");
});

// ─── The stand-in platform ────────────────────────────────────────────────────

type Asked = { method: string; url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
const asked: Asked[] = [];
type Reply = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
/** The platform as it answers a party it holds: a read of none, a request made, a line posted. */
const succeed: Reply = (req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET") return json(res, 200, { eventId: EVENT, hasConversation: true, current: null, history: [] });
  if (/\/menu-(link|received)$/.test(url)) return json(res, 200, { conversationId: randomUUID(), messageId: randomUUID(), language: "en", replayed: false });
  const state = url.endsWith("/cancel") ? "cancelled" : "requested";
  return json(res, 200, { request: request(state, { id: /deposit-request\/([^/]+)\//.exec(url)?.[1] ?? randomUUID() }), replayed: false });
};
let reply: Reply = succeed;
const platform = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    asked.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    reply(req, res, body);
  });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
const refuse = (status: number, code: string, message: string): Reply => (_req, res) => json(res, status, { error: { code, message } });
const hangUp: Reply = (req) => { req.socket.destroy(); };

await check("the client: the key as a Bearer and the press as the Idempotency-Key, no session; every door's path; the answers and refusals read", async () => {
  const config = { apiUrl: PLATFORM_API_URL, key: "zz-825-key" };
  const read = await readPartyDeposit(config, EVENT, "req-825");
  assert.ok(read.ok && read.answer.current === null && read.answer.hasConversation);
  assert.equal(asked.at(-1)!.url, `/otoapp/parties/${EVENT}/deposit-request`);
  assert.equal(asked.at(-1)!.headers.authorization, "Bearer zz-825-key");
  assert.equal(asked.at(-1)!.headers["x-request-id"], "req-825");
  assert.equal(asked.at(-1)!.headers.cookie, undefined, "no platform session travels");
  assert.equal(asked.at(-1)!.headers["idempotency-key"], undefined, "a read carries no press");

  const actionId = randomUUID();
  const conversationId = randomUUID();
  const made = await requestPartyDeposit(config, EVENT, { actionId, amountSatang: 300_000, actorAppUserId: "user-1", conversationId });
  assert.ok(made.ok && made.answer.request.state === "requested" && !made.answer.replayed);
  assert.equal(asked.at(-1)!.method, "POST");
  assert.equal(asked.at(-1)!.headers["idempotency-key"], actionId);
  assert.deepEqual(asked.at(-1)!.body, { amountSatang: 300_000, actorAppUserId: "user-1", conversationId }, "the press travels as the key, never in the body");

  const id = made.ok ? made.answer.request.id : "";
  const resent = await actOnPartyDeposit(config, EVENT, id, "resend", { actionId: randomUUID(), actorAppUserId: "user-1" });
  assert.ok(resent.ok && resent.answer.request.state === "requested");
  assert.equal(asked.at(-1)!.url, `/otoapp/parties/${EVENT}/deposit-request/${id}/resend`);
  assert.deepEqual(asked.at(-1)!.body, { actorAppUserId: "user-1" });
  const cancelled = await actOnPartyDeposit(config, EVENT, id, "cancel", { actionId: randomUUID(), actorAppUserId: "user-1" });
  assert.ok(cancelled.ok && cancelled.answer.request.state === "cancelled");

  const link = await postPartyMenuLink(config, EVENT, { actionId: randomUUID(), link: "https://app.zz-test.example/menu-select/tok", actorAppUserId: "user-1" });
  assert.ok(link.ok && link.answer.language === "en");
  assert.deepEqual(asked.at(-1)!.body, { link: "https://app.zz-test.example/menu-select/tok", actorAppUserId: "user-1" });
  const received = await postPartyMenuReceived(config, EVENT, { actionId: "menu-received:sel:2026-11-12T03:00:00.000Z", submittedAt: "2026-11-12T03:00:00.000Z" });
  assert.ok(received.ok);
  assert.equal(asked.at(-1)!.url, `/otoapp/parties/${EVENT}/menu-received`);
  assert.equal(asked.at(-1)!.headers["idempotency-key"], "menu-received:sel:2026-11-12T03:00:00.000Z");
  assert.deepEqual(asked.at(-1)!.body, { submittedAt: "2026-11-12T03:00:00.000Z" });

  reply = refuse(409, "DEPOSIT_REQUEST_OPEN", "A deposit request is already open for this party.");
  const open = await requestPartyDeposit(config, EVENT, { actionId: randomUUID(), amountSatang: 100, actorAppUserId: "u", conversationId: null });
  assert.deepEqual(open, { ok: false, status: 409, code: "DEPOSIT_REQUEST_OPEN", message: "A deposit request is already open for this party." });
  reply = refuse(401, "OTOAPP_PROVISION_UNAUTHORIZED", "x");
  const keyRefused = await readPartyDeposit(config, EVENT);
  assert.ok(!keyRefused.ok && keyRefused.status === 503 && /provisioning key/.test(keyRefused.message) && !keyRefused.message.includes("zz-825-key"));
  reply = refuse(404, "NOT_FOUND", "Party not found");
  const unknown = await readPartyDeposit(config, EVENT);
  assert.ok(!unknown.ok && unknown.status === 404 && /does not know this party/.test(unknown.message));
  reply = (_req, res) => json(res, 200, { eventId: EVENT });
  const unreadable = await readPartyDeposit(config, EVENT);
  assert.ok(!unreadable.ok && unreadable.code === "PLATFORM_UNREADABLE");
  reply = hangUp;
  const gone = await requestPartyDeposit(config, EVENT, { actionId: randomUUID(), amountSatang: 100, actorAppUserId: "u", conversationId: null });
  assert.ok(!gone.ok && gone.code === "PLATFORM_UNREACHABLE" && gone.status === 502 && /same press never asks twice/.test(gone.message));
  reply = succeed;
});

// ─── Rows ─────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

async function parkGroup(label: string, linked: boolean) {
  const tenant = randomUUID();
  const branch = randomUUID();
  const coreBranch = linked ? randomUUID() : null;
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-825-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)", [branch, tenant, `ZZ TEST ${label} park ${run}`, coreBranch]);
  return { tenant, branch, coreBranch };
}
async function user(g: { tenant: string }, role: string) {
  const id = randomUUID();
  const email = `zz-825-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
     values ($1, $2, $3, $4, $5, true, false, true)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [g.tenant, id]);
  return { id, email };
}
async function party(g: { tenant: string; branch: string }, title: string, o: { chat?: boolean; type?: string } = {}) {
  const id = randomUUID();
  const chat = o.chat === false ? null : randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status, inbox_conversation_id)
     values ($1, $2, $3, $4, $5, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming', $6)`,
    [id, g.tenant, g.branch, o.type ?? "birthday", `ZZ TEST BEO ${title} ${run}`, chat],
  );
  return { id, chat };
}

const A = await parkGroup("a", true);
const B = await parkGroup("b", true);
const unlinked = await parkGroup("unlinked", false);
const adminA = await user(A, "admin");
const managerA = await user(A, "manager");
const staffA = await user(A, "staff");
const adminU = await user(unlinked, "admin");
const partyA = await party(A, "a");
const partyNoChat = await party(A, "no-chat", { chat: false });
const camp = await party(A, "camp", { type: "camp" });
const partyB = await party(B, "b");
const partyU = await party(unlinked, "unlinked");

// ─── The app ──────────────────────────────────────────────────────────────────

const SESSION_SECRET = randomBytes(24).toString("hex");
const PUBLIC_ORIGIN = "https://app.zz-test.example";
const children: ChildProcess[] = [];
async function serve(env: Record<string, string>): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_ENV: "dev",
      DEPLOY_ENV: "local",
      OTOAPP_JOBS: "inprocess",
      STORAGE_ENV_PREFIX: "zz-test",
      OBJECT_STORAGE: "local",
      LOG_LEVEL: "warn",
      TZ: "UTC",
      USE_AWS_REKOGNITION: "false",
      OTOAPP_LEGACY_LOGIN: "true",
      SESSION_SECRET,
      PLATFORM_API_URL,
      OTOAPP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 180_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const m = /HARNESS_PORT=(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited ${code}:\n${output}`));
    });
  });
}

const call = async (origin: string, method: string, path: string, cookie: string, payload?: unknown) => {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body };
};
const signIn = async (origin: string, email: string) => {
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status}`);
  return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};
/** A pause for the submit hook, which tells the platform after the answer went out. */
const soon = () => new Promise((r) => setTimeout(r, 300));

try {
  const keyed = await serve({ OTOAPP_PROVISION_KEY: "zz-825-key" });
  const unkeyed = await serve({ OTOAPP_PROVISION_KEY: "" });
  const admin = await signIn(keyed, adminA.email);
  const manager = await signIn(keyed, managerA.email);
  const staff = await signIn(keyed, staffA.email);
  const read = (origin: string, cookie: string, eventId: string) => call(origin, "GET", `/api/events/${eventId}/beo/deposit-request`, cookie);
  const ask = (origin: string, cookie: string, eventId: string, over: Record<string, unknown> = {}) =>
    call(origin, "POST", `/api/events/${eventId}/beo/deposit-request`, cookie, { actionId: randomUUID(), amount: 3000, ...over });

  await check("the read answers the platform's state for a linked party, and says why not otherwise — never a state of its own", async () => {
    const ok = await read(keyed, admin, partyA.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "ok");
    assert.deepEqual(PartyDepositAnswerSchema.parse(ok.body.answer), { eventId: EVENT, hasConversation: true, current: null, history: [] });
    assert.equal(asked.at(-1)!.url, `/otoapp/parties/${partyA.id}/deposit-request`);
    assert.equal(asked.at(-1)!.headers.authorization, "Bearer zz-825-key");
    const before = asked.length;
    assert.equal((await read(keyed, await signIn(keyed, adminU.email), partyU.id)).body.status, "not_linked");
    assert.equal((await read(unkeyed, await signIn(unkeyed, adminA.email), partyA.id)).body.status, "unconfigured");
    assert.equal((await read(keyed, admin, camp.id)).body.status, "not_a_party");
    assert.equal(asked.length, before, "the platform was never asked for any of those");
    reply = hangUp;
    const down = await read(keyed, admin, partyA.id);
    assert.equal(down.body.status, "not_reachable");
    assert.match(down.body.message, /did not answer/);
    reply = succeed;
    assert.equal((await read(keyed, admin, partyB.id)).status, 404, "another park group's party is not found");
    assert.equal((await read(keyed, staff, partyA.id)).status, 200, "staff read the state too");
    assert.equal((await read(keyed, "", partyA.id)).status, 401);
  });

  await check("Request deposit: a manager's press goes to the platform as satang, who pressed and the party's chat, the press as the Idempotency-Key", async () => {
    const actionId = randomUUID();
    const before = asked.length;
    const res = await ask(keyed, manager, partyA.id, { actionId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.state, "requested");
    assert.equal(res.body.replayed, false);
    assert.equal(asked.length, before + 1);
    const sent = asked.at(-1)!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, `/otoapp/parties/${partyA.id}/deposit-request`);
    assert.equal(sent.headers.authorization, "Bearer zz-825-key");
    assert.equal(sent.headers["idempotency-key"], actionId);
    assert.equal(sent.headers.cookie, undefined);
    assert.deepEqual(sent.body, { amountSatang: 300_000, actorAppUserId: managerA.id, conversationId: partyA.chat });
    const byAdmin = await ask(keyed, admin, partyA.id);
    assert.equal(byAdmin.status, 200);
    assert.equal(asked.at(-1)!.body.actorAppUserId, adminA.id);
  });

  await check("refused before the platform is asked: staff, another park group's party, no chat, a camp, a park not linked, no key here, a bad amount", async () => {
    const before = asked.length;
    assert.equal((await ask(keyed, staff, partyA.id)).status, 403);
    assert.equal((await ask(keyed, admin, partyB.id)).status, 404);
    const noChat = await ask(keyed, admin, partyNoChat.id);
    assert.equal(noChat.status, 409);
    assert.equal(noChat.body.code, "PARTY_NO_CONVERSATION");
    assert.match(noChat.body.message, /not linked to an inbox chat/);
    const notParty = await ask(keyed, admin, camp.id);
    assert.equal(notParty.status, 409);
    assert.equal(notParty.body.code, "NOT_A_PARTY");
    const notLinked = await ask(keyed, await signIn(keyed, adminU.email), partyU.id);
    assert.equal(notLinked.status, 409);
    assert.equal(notLinked.body.code, "NOT_LINKED");
    const none = await ask(unkeyed, await signIn(unkeyed, adminA.email), partyA.id);
    assert.equal(none.status, 503);
    assert.match(none.body.message, /OTOAPP_PROVISION_KEY/);
    for (const bad of [{ amount: 0 }, { amount: 300.5 }, { amount: 2_000_000 }, { amount: "3000" }, { actionId: "not-a-uuid" }, { extra: 1 }]) {
      const res = await ask(keyed, admin, partyA.id, bad);
      assert.equal(res.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
      assert.ok(typeof res.body.message === "string" && res.body.message.length > 0);
    }
    assert.equal(asked.length, before, "the platform was never asked");
  });

  await check("the platform's refusal is answered in its words with its status; Resend and Cancel request forward the press", async () => {
    reply = refuse(409, "DEPOSIT_REQUEST_OPEN", "A deposit request is already open for this party. Resend it, or cancel it before asking for another.");
    const open = await ask(keyed, admin, partyA.id);
    assert.equal(open.status, 409);
    assert.equal(open.body.code, "DEPOSIT_REQUEST_OPEN");
    assert.match(open.body.message, /already open/);
    reply = succeed;
    const requestId = randomUUID();
    const actionId = randomUUID();
    const resent = await call(keyed, "POST", `/api/events/${partyA.id}/beo/deposit-request/${requestId}/resend`, manager, { actionId });
    assert.equal(resent.status, 200, JSON.stringify(resent.body));
    assert.equal(asked.at(-1)!.url, `/otoapp/parties/${partyA.id}/deposit-request/${requestId}/resend`);
    assert.equal(asked.at(-1)!.headers["idempotency-key"], actionId);
    assert.deepEqual(asked.at(-1)!.body, { actorAppUserId: managerA.id });
    const cancelled = await call(keyed, "POST", `/api/events/${partyA.id}/beo/deposit-request/${requestId}/cancel`, admin, { actionId: randomUUID() });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.state, "cancelled");
    assert.equal(asked.at(-1)!.url, `/otoapp/parties/${partyA.id}/deposit-request/${requestId}/cancel`);
    assert.equal((await call(keyed, "POST", `/api/events/${partyA.id}/beo/deposit-request/not-a-uuid/cancel`, admin, { actionId: randomUUID() })).status, 404);
    assert.equal((await call(keyed, "POST", `/api/events/${partyA.id}/beo/deposit-request/${requestId}/cancel`, staff, { actionId: randomUUID() })).status, 403);
  });

  // The set menu: a template with one choice, and the party's parent link.
  const templateId = randomUUID();
  await q("insert into beo_set_menu_templates (id, tenant_id, name, items) values ($1, $2, 'ZZ TEST set menu 825', $3)", [
    templateId,
    A.tenant,
    JSON.stringify([
      { id: "always-1", type: "always_included", label: "French fries", qty: 3 },
      { id: "main", type: "choice_group", label: "Main", options: ["Pizza", "Pasta"], allowMultiple: false },
    ]),
  ]);
  const token = randomBytes(24).toString("hex");
  const selectionId = randomUUID();

  await check("Send the menu choice link: refused by name without a parent link; with one, the link built from this deployment's address and the token", async () => {
    const none = await call(keyed, "POST", `/api/events/${partyA.id}/beo/menu-link`, admin, { actionId: randomUUID() });
    assert.equal(none.status, 409);
    assert.equal(none.body.code, "NO_MENU_LINK");
    await q("insert into beo_set_menu_selections (id, event_id, template_id, token, is_submitted) values ($1, $2, $3, $4, false)", [selectionId, partyA.id, templateId, token]);
    const actionId = randomUUID();
    const posted = await call(keyed, "POST", `/api/events/${partyA.id}/beo/menu-link`, admin, { actionId });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.replayed, false);
    assert.equal(asked.at(-1)!.url, `/otoapp/parties/${partyA.id}/menu-link`);
    assert.equal(asked.at(-1)!.headers["idempotency-key"], actionId);
    assert.deepEqual(asked.at(-1)!.body, { link: `${PUBLIC_ORIGIN}/menu-select/${token}`, actorAppUserId: adminA.id });
    assert.equal((await call(keyed, "POST", `/api/events/${partyA.id}/beo/menu-link`, staff, { actionId: randomUUID() })).status, 403);
    const noChat = await call(keyed, "POST", `/api/events/${partyNoChat.id}/beo/menu-link`, admin, { actionId: randomUUID() });
    assert.equal(noChat.body.code, "PARTY_NO_CONVERSATION");
  });

  await check("the parent's choices landed: the submit answers 200 as before, and the platform is told once, keyed by the submission; a second submit tells it nothing", async () => {
    const before = asked.length;
    const submit = () => call(keyed, "POST", `/api/beo/set-menu-selections/public/${token}/submit`, "", { selections: [{ groupId: "main", chosenOptions: ["Pizza"] }] });
    const first = await submit();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { success: true });
    await soon();
    assert.equal(asked.length, before + 1, "the platform was told once");
    const told = asked.at(-1)!;
    assert.equal(told.url, `/otoapp/parties/${partyA.id}/menu-received`);
    assert.equal(told.headers.authorization, "Bearer zz-825-key");
    const [row] = await q<{ submitted_at: Date }>("select submitted_at from beo_set_menu_selections where id = $1", [selectionId]);
    const submittedAt = new Date(row!.submitted_at).toISOString();
    assert.equal(told.headers["idempotency-key"], `menu-received:${selectionId}:${submittedAt}`);
    assert.deepEqual(told.body, { submittedAt });
    const kitchen = await q<{ menus: { kids: Array<{ itemName: string }> } }>("select menus from beo_kitchen_plans where event_id = $1", [partyA.id]);
    assert.deepEqual(kitchen[0]!.menus.kids.map((l) => l.itemName), ["French fries", "Pizza"], "the submit wrote the kitchen plan as before");
    const again = await submit();
    assert.equal(again.status, 409);
    await soon();
    assert.equal(asked.length, before + 1, "a refused second submit tells the platform nothing");
    const chosen = await call(keyed, "POST", `/api/events/${partyA.id}/beo/menu-link`, admin, { actionId: randomUUID() });
    assert.equal(chosen.status, 409);
    assert.equal(chosen.body.code, "MENU_ALREADY_CHOSEN");
  });

  console.log(`party-deposit.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
process.exit(checks === 8 ? 0 : 1);
