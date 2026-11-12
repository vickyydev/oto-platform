// seed: its own — one park group of ZZ TEST rows, made here and removed
// afterwards. Not a Playwright file: it mounts the app's AI routes (a stub
// model), the BEO's own routes and the platform's directory door on a bare
// server, beside a stand-in platform, and needs a database whose otoapp schema
// the app's migrator has built.
//
// SCRUM-843 — the AI Fill's "Approve and create" follows the Save's deposit
// rule (SCRUM-840, server/lib/depositSaveGuard.ts). A review read BEFORE the
// family paid through the chat and approved AFTER wrote the chat's deposit
// figure over the paid deposit. The screen's half is
// tests/ai-approve-deposit-ui.check.ts.
//
//   - the words, and what the review sends: the review carries the party's
//     one deposit as it was read (`oneDeposit`) and the approval's body sends
//     it back (`expectedDeposit`); a review from a server before the rule
//     sends none;
//   - THE RACE: a pasted message read into a review on a party with no
//     deposit (the chat says "deposit 1,000 received"), the platform's gateway
//     fact lands ฿3,000, the review is approved — the deposit is ฿3,000 in
//     every place the app keeps it, the approval's other fields are written,
//     the answer names the deposit under `notWritten` in plain words, the
//     activity row says why and no amount; the same for an approval carrying
//     0, and with the fact and the approval sent together;
//   - a deposit the chat only ASKS for is never money received: it is
//     billing's deposit required, on a party with no deposit and on one the
//     family has paid, and the paid deposit's three places are left alone;
//   - a fresh review (read with the stored deposit) approving a deliberate
//     higher figure writes it, without asking the platform; the amount the
//     party already holds, named with no day, keeps the stored day;
//   - an approval with no `expectedDeposit` (a page loaded before this build)
//     cannot lower the deposit, and can raise it;
//   - a deliberate lowering from a fresh review is written down to what the
//     family paid through the chat (the platform asked once, only then), kept
//     below it, and kept when the platform does not answer;
//   - the review names "deposit" among what the BEO already holds when the
//     deposit sits only on the event (paid through the chat, no billing row).
//
// Run from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/ai-approve-deposit.check.ts
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";
import type { BeoAiApproveBody, BeoAiReview } from "../shared/beoAiFill";
import type { PartyDepositRequest } from "../shared/partyDeposit";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ai-approve-deposit.check: DATABASE_URL is not set");
  process.exit(2);
}

// ─── The stand-in platform: what the family paid through the chat ─────────────

const paidThroughChat = new Map<string, PartyDepositRequest[]>();
let platformDown = false;
const askedOf: string[] = [];
const platform = createServer((req: IncomingMessage, res: ServerResponse) => {
  const eventId = /\/otoapp\/parties\/([^/]+)\/deposit-request$/.exec(req.url ?? "")?.[1] ?? "";
  // SCRUM-944: the fill now also reads the park's till menu from the platform; that is no deposit
  // ask. This stands in for the deposit door only: another path is not found, and not counted.
  if (!eventId) {
    res.writeHead(404, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "ZZ not this stand-in's door" } }));
  }
  askedOf.push(eventId);
  if (platformDown) return void req.socket.destroy();
  const history = paidThroughChat.get(eventId) ?? [];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ eventId, hasConversation: true, current: history[0] ?? null, history }));
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));

process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-843";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomUUID() + randomUUID();
process.env.LOG_LEVEL ??= "error";
process.env.PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
process.env.OTOAPP_PROVISION_KEY = "zz-843-key";

const { registerAIRoutes } = await import("../server/ai-routes");
const { registerBeoRoutes } = await import("../server/beo-routes");
const { directoryEventRouter } = await import("../server/directory/eventRoutes");
const { generateDirectoryKey, hashDirectoryKey } = await import("../server/directory/clientAuth");
const { pool: appDbPool } = await import("../server/db");
const { approvalResultWords, approveBodyOf, edited, initialReviewState, writtenSourcesOf } = await import("../client/src/lib/beo-ai-review");
const { depositNotApprovedWords } = await import("../shared/partyDeposit");
type AiCompleteOptions = import("../server/lib/anthropic").AiCompleteOptions;

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const DAY = "2099-03-02";
const MOVED_3000 = "it changed while this review was open (now ฿3,000)";

function paidRequest(eventId: string, amountSatang: number): PartyDepositRequest {
  return {
    id: randomUUID(),
    eventId,
    conversationId: randomUUID(),
    amountSatang,
    currency: "THB",
    state: "paid",
    paymentLink: null,
    linkExpiresAt: "2099-03-05T08:02:00.000Z",
    invoiceNo: "ZZ-WEB-843",
    requestedAt: "2099-03-01T08:02:00.000Z",
    remindedAt: null,
    handedOverAt: null,
    paidAt: "2099-03-02T10:00:00.000Z",
    closedAt: null,
    closeReason: null,
    depositBeforeSatang: 0,
    depositAfterSatang: amountSatang,
    writeBack: { editId: randomUUID(), syncState: "synced", syncError: null },
    requestLineStatus: null,
  };
}

// ─── The words, and what the review sends ─────────────────────────────────────

await check("the words: why an approval kept the deposit, and the result that says so", () => {
  assert.equal(depositNotApprovedWords("moved", 3000), MOVED_3000);
  assert.equal(depositNotApprovedWords("moved", 0), "it changed while this review was open (now none)");
  assert.equal(
    depositNotApprovedWords("unconfirmed", 3000),
    "it was not lowered (it stays ฿3,000): this page is out of date. Reload it, then run AI Fill again",
  );
  assert.equal(
    depositNotApprovedWords("gateway", 5000, 3000),
    "฿3,000 of it was paid through the chat, so the approval does not lower it below that (it stays ฿5,000). A paid deposit is corrected in the BEO's Billing section (Deposit Paid)",
  );
  assert.equal(
    depositNotApprovedWords("unchecked", 3000),
    "it was not lowered (it stays ฿3,000): the till could not be asked whether it was paid through the chat. Try again in a moment",
  );
  // The review's result: the deposit is not among what was saved, and why is said after it.
  const kept = approvalResultWords({ notWritten: { deposit: { reason: "moved", message: MOVED_3000, amountThb: 3000, date: DAY } } });
  assert.ok(kept.endsWith(" Not written: the deposit — it changed while this review was open (now ฿3,000)."), kept);
  assert.ok(kept.startsWith("Saved: the event's name and details,") && kept.includes("the timeline's steps and the team you ticked. Not written:"), kept);
  assert.ok(!/Saved:[^.]*deposit/.test(kept), "a deposit that was kept is not said to be saved");
  assert.ok(approvalResultWords({}).endsWith("the team you ticked and the deposit."), "an approval that wrote everything says so, as before");
  // The form wears no mark for a deposit that was not written.
  const sources: BeoAiApproveBody["sources"] = [{ field: "deposit", source: "team", at: null }, { field: "timeline:0", source: "team", at: null }, { field: "childName", source: "family", at: null }];
  assert.deepEqual(writtenSourcesOf(sources, { notWritten: { deposit: { message: MOVED_3000 } } }).map((s) => s.field), ["timeline:0", "childName"]);
  assert.deepEqual(writtenSourcesOf(sources, { notWritten: { timeline: { message: "x", steps: [] } } }).map((s) => s.field), ["deposit", "childName"]);
  assert.deepEqual(writtenSourcesOf(sources, {}), sources);
});

// ─── Rows ─────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const run = randomBytes(3).toString("hex");
const tenant = randomUUID();
const park = randomUUID();
const manager = randomUUID();
const entertainment = randomUUID();
const directoryKey = generateDirectoryKey();
const events: string[] = [];

async function party(title: string) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
     values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming')`,
    [id, tenant, park, `ZZ TEST 843 ${title} ${run}`],
  );
  events.push(id);
  return id;
}

// ─── The stub model: the deposit a pasted message names ───────────────────────

/** "ZZ843 PAID 1000 2099-03-01" → a deposit of ฿1,000 received that day; "ASKED 3000" → asked, not received; "NONE" → none. */
function answerFor(user: string) {
  const said = /ZZ843 (PAID|ASKED|NONE)(?: (\d+))?(?: (\d{4}-\d{2}-\d{2}))?/.exec(user);
  const deposit = said && said[1] !== "NONE" ? { amount: Number(said[2]), paid: said[1] === "PAID", date: said[3] ?? null, line: 1, source: "team" } : null;
  return {
    summary: "ZZ 843",
    event: { numChildren: 9 },
    catalogue: {
      event: { numChildren: { value: 9, line: 1, source: "team" } },
      requests: [{ kind: "decoration", text: "ZZ TEST balloons", line: 1, source: "team" }],
      ...(deposit ? { deposit } : {}),
    },
  };
}
const ai = {
  configured: () => true,
  complete: async (call: AiCompleteOptions) => {
    const { catalogue, ...form } = answerFor(call.user);
    if (call.system.includes("THE CONVERSATION")) return JSON.stringify({ catalogue });
    return JSON.stringify(call.system.includes("THE PARK'S CATALOGUE") ? { ...form, catalogue } : form);
  },
};

// ─── The app ──────────────────────────────────────────────────────────────────

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  if (req.get("x-test-as") !== "manager") return res.status(401).json({ message: "Not signed in" });
  const r = req as unknown as Record<string, unknown>;
  r.isAuthenticated = () => true;
  r.user = { id: manager, tenantId: tenant, role: "manager" };
  r.userWithAccess = { id: manager, tenantId: tenant, isActive: true, role: "manager", hasAllBranchesAccess: false, allowedBranchIds: [park] };
  next();
}
const servers: Server[] = [platform];
const app = express();
app.use(express.json({ limit: "1mb" }));
// The BEO's own routes take the session the app's passport would give; the directory door takes its key.
app.use((req, res, next) => (req.get("x-test-as") ? fakeAuth(req, res, next) : next()));
registerAIRoutes(app, fakeAuth, { ai });
registerBeoRoutes(app);
app.use(directoryEventRouter(appDbPool));
const server = createServer(app);
servers.push(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Answer = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
async function send(method: string, path: string, body: unknown, headers: Record<string, string> = { "x-test-as": "manager" }): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const show = (r: Answer) => `${r.status} ${JSON.stringify(r.body)}`;

/** The review a pasted message opens: the server's answer, as the BEO form receives it. */
async function readReview(eventId: string, text: string) {
  const res = await send("POST", "/api/ai/parse-beo", { text, existingData: {}, eventId });
  assert.equal(res.status, 200, show(res));
  const review = res.body.review as BeoAiReview | undefined;
  assert.ok(review, "the pasted message opens the review (the park has a catalogue)");
  return { review, fill: res.body as unknown };
}
/** The body the review's own "Approve and create" builds, the deposit as the reviewer left it. */
function bodyOf(read: { review: BeoAiReview; fill: unknown }, deposit?: { amount: number; paid: boolean; date: string }): BeoAiApproveBody {
  const state = initialReviewState(read.review, { fill: read.fill, bookedDate: "2099-03-14" });
  return approveBodyOf(read.review, deposit ? { ...state, deposit: edited(state.deposit, deposit) } : state, { conversationId: null, messageId: null });
}
const approve = (eventId: string, body: unknown) => send("POST", `/api/events/${eventId}/beo/ai-fill/approve`, body);
/** The platform's write-back of a gateway-paid deposit (SCRUM-825), as its directory client sends it. */
const gatewayFact = (eventId: string, amountThb: number, day = DAY) =>
  send(
    "POST",
    `/api/directory/events/${eventId}/edits`,
    { id: randomUUID(), editedAt: "2000-01-01T00:00:00Z", fields: { prepaymentAmountThb: amountThb, prepaymentDate: day }, fact: "gateway_deposit" },
    { authorization: `Bearer ${directoryKey}` },
  );

/** The deposit in every place the app keeps it, as the till's view reads it, and the BEO's read; and the approval's other fields. */
async function homes(eventId: string) {
  const [ev] = await q<{ prepayment_amount: number | null; prepayment_date: string | null; decoration: string | null; num_children: number | null }>(
    "select prepayment_amount, prepayment_date, decoration, num_children from core_events where id = $1", [eventId]);
  const [bl] = await q<{ deposit_paid: boolean | null; deposit_paid_amount: number | null; paid_on: string | null; deposit_required: boolean | null; deposit_amount: number | null; pd: Record<string, unknown> | null }>(
    `select deposit_paid, deposit_paid_amount, deposit_paid_at::date::text as paid_on, deposit_required, deposit_amount, add_ons -> 'partyDetails' as pd
       from beo_event_billing where event_id = $1`,
    [eventId]);
  const [view] = await q<{ d: number | null }>("select deposit_satang::integer as d from otoapp_v.events where id = $1", [eventId]);
  const beo = await send("GET", `/api/events/${eventId}/beo`, undefined);
  assert.equal(beo.status, 200, show(beo));
  return {
    deposit: {
      event: [ev!.prepayment_amount, ev!.prepayment_date],
      billing: bl ? [bl.deposit_paid === true, bl.deposit_paid_amount, bl.paid_on] : null,
      partyDetails: bl?.pd ? [bl.pd.prepaymentReceived ?? null, bl.pd.depositDate ?? null] : null,
      till: view?.d ?? null,
      read: beo.body.oneDeposit,
    },
    asked: bl ? [bl.deposit_required === true, bl.deposit_amount] : null,
    decoration: ev!.decoration,
    numChildren: ev!.num_children,
  };
}
const everywhere = (amountThb: number, day: string | null) => ({
  event: [amountThb, day], billing: [true, amountThb, day], partyDetails: [amountThb, day], till: amountThb * 100, read: { amountThb, date: day },
});
type Homes = Awaited<ReturnType<typeof homes>>["deposit"];
/**
 * The deposit as every reader reads it: the event's own, the till's view and the BEO's read; and
 * the billing's two places wherever the party keeps a billing row (one the BEO was never saved
 * on, and no approval wrote a deposit to, keeps none: its readers read the event's own).
 */
function stands(h: Homes, amountThb: number, day: string | null, why = "the deposit, in every place") {
  const all = everywhere(amountThb, day);
  assert.deepEqual({ event: h.event, till: h.till, read: h.read }, { event: all.event, till: all.till, read: all.read }, why);
  if (h.billing) assert.deepEqual({ billing: h.billing, partyDetails: h.partyDetails }, { billing: all.billing, partyDetails: all.partyDetails }, why);
}
/** The newest approval's activity row for an event: what it says was and was not written. */
async function approvedRow(eventId: string) {
  const rows = await q<{ metadata_json: string }>(
    "select metadata_json from activity_log where activity_type = 'beo_ai_fill' and metadata_json like $1 order by created_at desc", [`%${eventId}%`]);
  const row = rows.map((r) => ({ raw: r.metadata_json, meta: JSON.parse(r.metadata_json) })).find((r) => r.meta.step === "approved");
  assert.ok(row, "the approval left its activity row");
  return row;
}

try {
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 843 ${run}`, `zz-843-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, timezone, core_branch_id) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok', $4)", [
    park, tenant, `ZZ TEST 843 park ${run}`, randomUUID(),
  ]);
  await q("insert into users (id, email, password, full_name, role, is_active, must_change_password) values ($1, $2, 'x', 'ZZ TEST 843', 'manager', true, false)", [
    manager, `zz-843-${manager.slice(0, 8)}@example.com`,
  ]);
  // One line of the park's catalogue: with none the pasted message opens the free-text preview, never the review.
  await q(
    `insert into entertainment_package_templates (id, tenant_id, name, category, duration_minutes, default_price, billable_by_default, unit, sort_order)
     values ($1, $2, 'ZZ TEST 843 show', 'Shows', 30, 100000, true, 'session', 1)`,
    [entertainment, tenant],
  );
  await q("insert into directory_clients (tenant_id, name, key_hash, scopes, is_active) values ($1, $2, $3, $4, true)", [
    tenant, `ZZ TEST 843 platform ${run}`, hashDirectoryKey(directoryKey), ["events:write"],
  ]);

  await check("the review carries the party's one deposit as it was read, and Approve and create sends it back", async () => {
    const none = await party("carries-none");
    const first = await readReview(none, "Confirmed. ZZ843 PAID 1000 2099-03-01");
    assert.deepEqual(first.review.oneDeposit, { amountThb: 0, date: null });
    assert.deepEqual(first.review.proposal.deposit && { amount: first.review.proposal.deposit.amount, paid: first.review.proposal.deposit.paid }, { amount: 1000, paid: true });
    assert.deepEqual(bodyOf(first).expectedDeposit, { amountThb: 0, date: null });
    assert.ok(!first.review.replaces.includes("deposit"));
    // Paid through the chat on a party the BEO was never saved on: the deposit is the event's own, and the review reads it.
    assert.equal((await gatewayFact(none, 3000)).status, 200);
    const second = await readReview(none, "Confirmed. ZZ843 NONE");
    assert.deepEqual(second.review.oneDeposit, { amountThb: 3000, date: DAY });
    assert.ok(second.review.replaces.includes("deposit"), "the review names the deposit among what the BEO already holds");
    const body = bodyOf(second);
    assert.deepEqual(body.expectedDeposit, { amountThb: 3000, date: DAY });
    assert.equal(body.deposit, null, "a chat that names no deposit sends none");
    // A review from a server before the rule: nothing to send back.
    const { oneDeposit: _gone, ...old } = second.review;
    assert.ok(!("expectedDeposit" in bodyOf({ review: old, fill: second.fill })));
    // A body off the shape is refused whole, as before.
    assert.equal((await approve(none, { ...body, expectedDeposit: { amountThb: -1, date: null } })).status, 400);
    assert.equal((await approve(none, { ...body, expectedDeposit: { amountThb: 3000 } })).status, 400);
  });

  await check("THE RACE: a review read with no deposit, the family pays ฿3,000 through the chat, the review is approved — the deposit stays ฿3,000 everywhere, the rest is written, the answer names the deposit", async () => {
    const asked = askedOf.length;
    // 1. The chat's own figure ("deposit 1,000 received"), as the review proposes it.
    const stale = await party("race");
    const read = await readReview(stale, "Confirmed. ZZ843 PAID 1000 2099-03-01");
    assert.deepEqual(read.review.oneDeposit, { amountThb: 0, date: null });
    const fact = await gatewayFact(stale, 3000);
    assert.equal(fact.status, 200, show(fact));
    stands((await homes(stale)).deposit, 3000, DAY);
    const body = bodyOf(read);
    assert.deepEqual(body.deposit, { amount: 1000, paid: true, date: "2099-03-01" });
    const res = await approve(stale, body);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body.notWritten, { deposit: { reason: "moved", message: MOVED_3000, amountThb: 3000, date: DAY } });
    assert.equal(res.body.written.deposit, undefined, "the deposit is not said to be written");
    assert.equal(res.body.written.event, true);
    const after = await homes(stale);
    stands(after.deposit, 3000, DAY, "the paid deposit, in every place");
    assert.equal(after.numChildren, 9, "the approval's other fields are written");
    assert.equal(after.decoration, "ZZ TEST balloons");
    assert.ok(!after.asked?.[0], "and nothing is marked as asked");
    const row = await approvedRow(stale);
    assert.deepEqual(row.meta.notWritten, { deposit: { reason: "moved" } });
    assert.equal(row.meta.written.deposit, undefined);
    assert.ok(!row.raw.includes("3000") && !row.raw.includes("3,000"), "the activity row names no amount");

    // 2. An approval carrying 0 as received (the API takes it): kept too.
    const zero = await party("race-zero");
    const zeroRead = await readReview(zero, "Confirmed. ZZ843 NONE");
    assert.equal((await gatewayFact(zero, 3000)).status, 200);
    const cleared = await approve(zero, { ...bodyOf(zeroRead), deposit: { amount: 0, paid: true, date: null } });
    assert.equal(cleared.status, 200, show(cleared));
    assert.equal(cleared.body.notWritten?.deposit?.reason, "moved");
    assert.equal(cleared.body.notWritten?.deposit?.message, MOVED_3000);
    stands((await homes(zero)).deposit, 3000, DAY);

    // 3. A higher figure than the paid one, from the stale review: kept as well, and said — the
    //    reviewer reads the paid deposit and runs AI Fill again on it.
    const higher = await party("race-higher");
    const higherRead = await readReview(higher, "Confirmed. ZZ843 PAID 9000 2099-03-01");
    assert.equal((await gatewayFact(higher, 3000)).status, 200);
    const kept = await approve(higher, bodyOf(higherRead));
    assert.equal(kept.body.notWritten?.deposit?.reason, "moved", show(kept));
    stands((await homes(higher)).deposit, 3000, DAY);

    // 4. The fact and the approval sent together, both ways round: ฿3,000 stands either way.
    for (const order of ["fact first", "approval first"] as const) {
      const both = await party(`race-together-${order.replace(" ", "-")}`);
      const bothRead = await readReview(both, "Confirmed. ZZ843 PAID 1000 2099-03-01");
      const sent = order === "fact first"
        ? await Promise.all([gatewayFact(both, 3000), approve(both, bodyOf(bothRead))])
        : await Promise.all([approve(both, bodyOf(bothRead)), gatewayFact(both, 3000)]).then(([a, f]) => [f, a] as const);
      assert.equal(sent[0].status, 200, show(sent[0]));
      assert.equal(sent[1].status, 200, show(sent[1]));
      const together = await homes(both);
      stands(together.deposit, 3000, DAY, `${order}: the paid deposit stands`);
      assert.equal(together.numChildren, 9);
    }
    assert.equal(askedOf.length, asked, "a deposit that moved is kept without asking the platform");
  });

  await check("a deposit the chat only ASKS for is never money received: billing's deposit required, the paid deposit's places untouched", async () => {
    // On a party with no deposit: nothing is received anywhere.
    const fresh = await party("asked");
    const read = await readReview(fresh, "Please pay. ZZ843 ASKED 3000");
    const body = bodyOf(read);
    assert.deepEqual(body.deposit, { amount: 3000, paid: false, date: null });
    const res = await approve(fresh, body);
    assert.equal(res.status, 200, show(res));
    assert.equal(res.body.notWritten, undefined);
    assert.equal(res.body.written.deposit, true);
    const after = await homes(fresh);
    assert.deepEqual(after.asked, [true, 3000], "the amount requested");
    assert.deepEqual(after.deposit.event, [null, null], "the event's Prepayment is empty");
    assert.deepEqual(after.deposit.billing, [false, null, null], "billing says not paid");
    assert.ok(!after.deposit.till, "the till reads no deposit paid");
    assert.deepEqual(after.deposit.read, { amountThb: 0, date: null });
    assert.ok(!(Number(after.deposit.partyDetails?.[0] ?? 0) > 0), "Party Details holds no prepayment received");

    // Read before the family paid, approved after: the asked amount is written beside the paid deposit, never over it.
    const paid = await party("asked-over-paid");
    const stale = await readReview(paid, "Please pay. ZZ843 ASKED 2000");
    assert.equal((await gatewayFact(paid, 3000)).status, 200);
    const over = await approve(paid, bodyOf(stale));
    assert.equal(over.status, 200, show(over));
    assert.equal(over.body.notWritten, undefined, "nothing of the paid deposit was touched, so nothing to say");
    const both = await homes(paid);
    assert.deepEqual(both.deposit.event, [3000, DAY]);
    assert.equal(both.deposit.till, 300_000);
    assert.deepEqual(both.deposit.read, { amountThb: 3000, date: DAY });
    assert.deepEqual(both.asked, [true, 2000]);
  });

  await check("a fresh review approving a deliberate higher figure writes it, without asking the platform", async () => {
    const asked = askedOf.length;
    const id = await party("raise");
    assert.equal((await gatewayFact(id, 3000)).status, 200);
    const read = await readReview(id, "Confirmed. ZZ843 PAID 5000 2099-03-05");
    assert.deepEqual(read.review.oneDeposit, { amountThb: 3000, date: DAY });
    const res = await approve(id, bodyOf(read));
    assert.equal(res.status, 200, show(res));
    assert.equal(res.body.notWritten, undefined);
    assert.equal(res.body.written.deposit, true);
    assert.deepEqual((await homes(id)).deposit, everywhere(5000, "2099-03-05"));
    // The figure the party already holds, approved again: written as before, nothing to say.
    const again = await readReview(id, "Confirmed. ZZ843 PAID 5000 2099-03-05");
    const same = await approve(id, bodyOf(again));
    assert.equal(same.body.notWritten, undefined, show(same));
    assert.equal(same.body.written.deposit, true);
    assert.deepEqual((await homes(id)).deposit, everywhere(5000, "2099-03-05"));
    // The same amount with no day (the chat gave none): the stored deposit, its day kept — from a
    // fresh review, and from one read before the family paid that very amount through the chat.
    const noDay = await readReview(id, "Confirmed. ZZ843 PAID 5000");
    assert.deepEqual(bodyOf(noDay).deposit, { amount: 5000, paid: true, date: null });
    const keptDay = await approve(id, bodyOf(noDay));
    assert.equal(keptDay.body.notWritten, undefined, show(keptDay));
    assert.deepEqual((await homes(id)).deposit, everywhere(5000, "2099-03-05"), "the day the deposit was paid is not cleared");
    const early = await party("same-figure");
    const earlyRead = await readReview(early, "Confirmed. ZZ843 PAID 3000");
    assert.deepEqual(earlyRead.review.oneDeposit, { amountThb: 0, date: null });
    assert.equal((await gatewayFact(early, 3000)).status, 200);
    const agreed = await approve(early, bodyOf(earlyRead));
    assert.equal(agreed.status, 200, show(agreed));
    assert.equal(agreed.body.notWritten, undefined, "the chat's figure is the paid one: nothing to say");
    assert.deepEqual((await homes(early)).deposit, everywhere(3000, DAY));
    assert.equal(askedOf.length, asked);
  });

  await check("an approval that names no expectedDeposit (a page loaded before this build) cannot lower the deposit, and can raise it", async () => {
    const asked = askedOf.length;
    const id = await party("old-page");
    assert.equal((await gatewayFact(id, 3000)).status, 200);
    const read = await readReview(id, "Confirmed. ZZ843 PAID 1000 2099-03-01");
    const { expectedDeposit: _none, ...old } = bodyOf(read);
    const lowered = await approve(id, old);
    assert.equal(lowered.status, 200, show(lowered));
    assert.deepEqual(lowered.body.notWritten, {
      deposit: { reason: "unconfirmed", message: "it was not lowered (it stays ฿3,000): this page is out of date. Reload it, then run AI Fill again", amountThb: 3000, date: DAY },
    });
    const after = await homes(id);
    stands(after.deposit, 3000, DAY);
    assert.equal(after.numChildren, 9, "the rest of the approval is written");
    const cleared = await approve(id, { ...old, deposit: { amount: 0, paid: true, date: null } });
    assert.equal(cleared.body.notWritten?.deposit?.reason, "unconfirmed", show(cleared));
    stands((await homes(id)).deposit, 3000, DAY);
    const raised = await approve(id, { ...old, deposit: { amount: 4000, paid: true, date: DAY } });
    assert.equal(raised.body.notWritten, undefined, show(raised));
    assert.deepEqual((await homes(id)).deposit, everywhere(4000, DAY));
    assert.equal(askedOf.length, asked, "an old page is kept without asking the platform");
  });

  await check("a deliberate lowering from a fresh review goes down to what the family paid through the chat, never below it, and not at all when the platform does not answer", async () => {
    const id = await party("lower");
    paidThroughChat.set(id, [paidRequest(id, 300_000)]);
    assert.equal((await gatewayFact(id, 3000)).status, 200);
    // ฿2,000 more in cash, typed in the BEO: the party holds ฿5,000, ฿3,000 of it through the chat.
    const first = await readReview(id, "Confirmed. ZZ843 PAID 5000");
    assert.equal((await approve(id, bodyOf(first, { amount: 5000, paid: true, date: DAY }))).status, 200);
    assert.deepEqual((await homes(id)).deposit, everywhere(5000, DAY));

    // Down to ฿4,000: above the chat's payment, written; the platform asked once.
    let asked = askedOf.length;
    const fresh = await readReview(id, "Confirmed. ZZ843 PAID 4000");
    const down = await approve(id, bodyOf(fresh, { amount: 4000, paid: true, date: DAY }));
    assert.equal(down.status, 200, show(down));
    assert.equal(down.body.notWritten, undefined);
    assert.deepEqual((await homes(id)).deposit, everywhere(4000, DAY));
    assert.deepEqual(askedOf.slice(asked), [id], "the platform is asked once, for this party");

    // Down to ฿2,000: below the chat's payment — kept, and said.
    asked = askedOf.length;
    const again = await readReview(id, "Confirmed. ZZ843 PAID 2000");
    const below = await approve(id, bodyOf(again, { amount: 2000, paid: true, date: DAY }));
    assert.equal(below.status, 200, show(below));
    assert.deepEqual(below.body.notWritten, {
      deposit: {
        reason: "gateway",
        message: "฿3,000 of it was paid through the chat, so the approval does not lower it below that (it stays ฿4,000). A paid deposit is corrected in the BEO's Billing section (Deposit Paid)",
        amountThb: 4000,
        date: DAY,
      },
    });
    assert.deepEqual((await homes(id)).deposit, everywhere(4000, DAY));
    assert.equal(askedOf.length, asked + 1);

    // The platform does not answer: the deposit is not lowered on a guess.
    platformDown = true;
    try {
      const blind = await approve(id, bodyOf(again, { amount: 3500, paid: true, date: DAY }));
      assert.equal(blind.status, 200, show(blind));
      assert.equal(blind.body.notWritten?.deposit?.reason, "unchecked");
      assert.equal(
        blind.body.notWritten?.deposit?.message,
        "it was not lowered (it stays ฿4,000): the till could not be asked whether it was paid through the chat. Try again in a moment",
      );
      assert.deepEqual((await homes(id)).deposit, everywhere(4000, DAY));
      assert.equal((await homes(id)).numChildren, 9);
    } finally {
      platformDown = false;
    }

    // A party the chat paid nothing for: a fresh review lowers it freely.
    const cash = await party("lower-cash");
    const typed = await readReview(cash, "Confirmed. ZZ843 PAID 5000");
    assert.equal((await approve(cash, bodyOf(typed, { amount: 5000, paid: true, date: DAY }))).status, 200);
    const less = await readReview(cash, "Confirmed. ZZ843 PAID 1000");
    const lowered = await approve(cash, bodyOf(less, { amount: 1000, paid: true, date: DAY }));
    assert.equal(lowered.body.notWritten, undefined, show(lowered));
    assert.deepEqual((await homes(cash)).deposit, everywhere(1000, DAY));
  });
} finally {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await q("delete from activity_log where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from beo_timeline_items where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from beo_event_billing where event_id = any($1::uuid[])", [events]).catch(() => undefined);
  await q("delete from core_events where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from entertainment_package_templates where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from directory_clients where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from users where id = $1", [manager]).catch(() => undefined);
  await q("delete from branches where tenant_id = $1", [tenant]).catch(() => undefined);
  await q("delete from tenants where id = $1", [tenant]).catch(() => undefined);
  await pool.end();
  await appDbPool.end().catch(() => undefined);
}

console.log(`ai-approve-deposit.check: ${checks} checks passed`);
process.exit(checks === 7 ? 0 : 1);
