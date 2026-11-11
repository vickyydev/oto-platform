// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) and a
// stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built.
//
// SCRUM-840 — a Save never lowers or clears a deposit it did not deliberately
// change (server/lib/depositSaveGuard.ts). The screen's half is
// tests/deposit-save-ui.check.ts.
//
//   - the rule on its own: a Save carrying the stored deposit writes nothing;
//     a form opened with another deposit than the stored one keeps the stored
//     one (`moved`), whatever it carries; a lowering with no `expected` is
//     kept (`unconfirmed`), a raise is written; a deliberate lowering is
//     written down to what the family paid through the chat, kept below it
//     (`gateway`) and kept when the platform could not be asked
//     (`unchecked`); what was paid through the chat is every paid request;
//     the form says whether the person changed its deposit;
//   - THE RACE on the BEO's Save (PUT /api/events/:id/beo): the BEO read with
//     no deposit, the platform's gateway fact lands ฿3,000, the stale form is
//     saved — the deposit is ฿3,000 in every place the app keeps it, the
//     form's other fields are saved, the answer says the deposit was kept;
//     the same for a form that also typed another figure, for a page from
//     before the rule (no `expectedDeposit`), and with the fact and the Save
//     sent together;
//   - a deliberate change from a fresh form is written: raised, lowered above
//     what the chat paid (the platform asked once, and only then), cleared on
//     a party the chat paid nothing for; lowered below the chat's payment it
//     is kept and said, and kept when the platform does not answer;
//   - the Billing section's Deposit Paid (PUT …/beo/billing) with the deposit
//     it showed: one that moved is kept and said, the write's other fields
//     saved; a deliberate figure is written, as is a write that names none;
//   - the Events page's Save (PATCH /api/admin/events/:id): the same rule,
//     "while this event was open"; its other fields saved;
//   - nobody else is in the way: a till's party edit still lowers the
//     deposit, and the gateway fact still lands over a Save made since.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/deposit-save.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { depositChangedIn, loadedDepositOf } from "../client/src/lib/beo-deposit-buffer";
import { generateDirectoryKey, hashDirectoryKey } from "../server/directory/clientAuth";
import { decideDepositSave, depositNamedBy, expectedDepositOf, gatewayPaidThbOf, lowersDeliberately, partyDetailsWithDeposit } from "../server/lib/depositSaveGuard";
import { depositMovedWords, type PartyDepositRequest } from "../shared/partyDeposit";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("deposit-save.check: DATABASE_URL is not set");
  process.exit(2);
}

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

const MOVED_3000 = "The deposit changed while this BEO was open (now ฿3,000). Your other changes were saved.";
const DAY = "2099-03-02";

function paidRequest(eventId: string, amountSatang: number, over: Partial<PartyDepositRequest> = {}): PartyDepositRequest {
  return {
    id: randomUUID(),
    eventId,
    conversationId: randomUUID(),
    amountSatang,
    currency: "THB",
    state: "paid",
    paymentLink: null,
    linkExpiresAt: "2099-03-05T08:02:00.000Z",
    invoiceNo: "ZZ-WEB-840",
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
    ...over,
  };
}

// ─── The rule, on its own ─────────────────────────────────────────────────────

await check("the rule: the stored deposit stays unless the form was opened with it and changed it; a lowering is checked against the chat's payment", () => {
  const none = { amountThb: 0, date: null };
  const paid = { amountThb: 3000, date: DAY };
  // The Save carries the stored deposit: nothing to write, nothing to say, whatever the form was opened with.
  assert.deepEqual(decideDepositSave({ was: paid, said: paid, expected: none }), { write: null, note: null });
  // Opened with no deposit, the family paid meanwhile: kept, whatever the form carries (the old 0, another figure, or none).
  for (const said of [none, { amountThb: 1000, date: null }, { amountThb: 9000, date: DAY }, null]) {
    const d = decideDepositSave({ was: paid, said, expected: none });
    assert.equal(d.write, null);
    assert.deepEqual(d.note, { kept: true, reason: "moved", amountThb: 3000, date: DAY, message: MOVED_3000 });
  }
  assert.equal(decideDepositSave({ was: none, said: null, expected: paid }).note?.message, "The deposit changed while this BEO was open (now none). Your other changes were saved.");
  assert.match(decideDepositSave({ was: paid, said: none, expected: none, screen: "event" }).note!.message, /while this event was open \(now ฿3,000\)/);
  // The day alone moved: the form's deposit is no longer the stored one.
  assert.equal(decideDepositSave({ was: paid, said: { amountThb: 3000, date: "2099-03-09" }, expected: { amountThb: 3000, date: "2099-03-01" } }).note?.reason, "moved");
  // A deposit of 0 has no day: a form that kept a stale day beside 0 was opened with no deposit.
  assert.deepEqual(decideDepositSave({ was: none, said: paid, expected: { amountThb: 0, date: "2099-01-01" } }), { write: paid, note: null });
  // A form that names no deposit and was opened with the stored one: nothing.
  assert.deepEqual(decideDepositSave({ was: paid, said: null, expected: paid }), { write: null, note: null });
  // A page from before the rule (no `expected`): a lowering is not trusted, a raise and a new day are written.
  const old = decideDepositSave({ was: paid, said: none, expected: undefined });
  assert.equal(old.write, null);
  assert.equal(old.note?.reason, "unconfirmed");
  assert.match(old.note!.message, /was not lowered \(it stays ฿3,000\): this page is out of date/);
  assert.deepEqual(decideDepositSave({ was: paid, said: { amountThb: 4000, date: DAY }, expected: undefined }).write, { amountThb: 4000, date: DAY });
  assert.deepEqual(decideDepositSave({ was: paid, said: { amountThb: 3000, date: "2099-03-09" }, expected: undefined }).write, { amountThb: 3000, date: "2099-03-09" });
  // Deliberate (opened with the stored deposit): raised without asking anybody; lowered only as far as the chat's payment.
  assert.deepEqual(decideDepositSave({ was: paid, said: { amountThb: 5000, date: DAY }, expected: paid }).write, { amountThb: 5000, date: DAY });
  assert.deepEqual(decideDepositSave({ was: paid, said: none, expected: paid, floor: { known: true, amountThb: 0 } }), { write: none, note: null });
  assert.deepEqual(decideDepositSave({ was: { amountThb: 4000, date: DAY }, said: paid, expected: { amountThb: 4000, date: DAY }, floor: { known: true, amountThb: 3000 } }).write, paid);
  const below = decideDepositSave({ was: paid, said: { amountThb: 2000, date: DAY }, expected: paid, floor: { known: true, amountThb: 3000 } });
  assert.equal(below.write, null);
  assert.equal(below.note?.reason, "gateway");
  assert.match(below.note!.message, /^฿3,000 of this deposit was paid through the chat, so Save does not lower it below that \(it stays ฿3,000\)\. Your other changes were saved\./);
  for (const floor of [undefined, { known: false } as const]) {
    const unchecked = decideDepositSave({ was: paid, said: none, expected: paid, floor });
    assert.equal(unchecked.write, null);
    assert.equal(unchecked.note?.reason, "unchecked");
    assert.match(unchecked.note!.message, /the till could not be asked whether it was paid through the chat/);
  }
  // The platform is asked only for a deliberate lowering.
  assert.equal(lowersDeliberately(paid, none, paid), true);
  assert.equal(lowersDeliberately(paid, none, none), false, "a stale form is kept without asking");
  assert.equal(lowersDeliberately(paid, none, undefined), false, "an old page is kept without asking");
  assert.equal(lowersDeliberately(paid, { amountThb: 5000, date: DAY }, paid), false);
  assert.equal(lowersDeliberately(paid, null, paid), false);

  // What the family paid through the chat: every paid request, once each; open, expired and cancelled ones are not money.
  const a = paidRequest("e", 300_000);
  const b = paidRequest("e", 150_050);
  assert.equal(gatewayPaidThbOf({ current: a, history: [a, b, paidRequest("e", 900_000, { state: "cancelled" }), paidRequest("e", 900_000, { state: "requested" }), paidRequest("e", 1, { state: "expired" })] }), 4501);
  assert.equal(gatewayPaidThbOf({ current: null, history: [] }), 0);

  // What a form says it was opened with, and what its Party Details names.
  assert.equal(expectedDepositOf(undefined), undefined);
  assert.equal(expectedDepositOf({ date: DAY }), undefined);
  assert.deepEqual(expectedDepositOf({ amountThb: "3000", date: `${DAY}T00:00:00.000Z` }), paid);
  assert.deepEqual(expectedDepositOf({ amountThb: 0, date: DAY }), none);
  assert.equal(depositNamedBy({ packageName: "x", notes: "y" }, paid), null, "a form that did not touch the deposit names none");
  assert.deepEqual(depositNamedBy({ prepaymentReceived: 0, depositDate: "" }, paid), none);
  assert.deepEqual(depositNamedBy({ depositDate: "2099-03-09" }, paid), { amountThb: 3000, date: "2099-03-09" });
  assert.deepEqual(partyDetailsWithDeposit({ packageName: "x", prepaymentReceived: 0, depositDate: "" }, paid), { packageName: "x", prepaymentReceived: 3000, depositDate: DAY });
  assert.deepEqual(partyDetailsWithDeposit({ notes: "n", depositDate: "2099-01-01" }, none), { notes: "n", prepaymentReceived: 0 });

  // The form's half: the deposit it was opened with, and the fields it sends only when the person changed them.
  assert.deepEqual(loadedDepositOf({ oneDeposit: { amountThb: 3000, date: DAY }, partyDetails: { prepaymentReceived: 1 } }), paid);
  assert.deepEqual(loadedDepositOf({ partyDetails: { prepaymentReceived: 3000, depositDate: DAY } }), paid, "a server from before the rule: Party Details' own");
  assert.deepEqual(loadedDepositOf({ partyDetails: null }), none);
  assert.equal(depositChangedIn({ prepaymentReceived: 3000, depositDate: DAY }, paid), false);
  assert.equal(depositChangedIn({ prepaymentReceived: 0, depositDate: "" }, none), false);
  assert.equal(depositChangedIn({ prepaymentReceived: 0, depositDate: "2099-01-01" }, none), false, "a day beside no deposit is no deposit");
  assert.equal(depositChangedIn({ prepaymentReceived: 0, depositDate: "" }, paid), true);
  assert.equal(depositChangedIn({ prepaymentReceived: 3000, depositDate: "2099-03-09" }, paid), true);
  assert.equal(depositMovedWords(3000), "The deposit changed while this BEO was open (now ฿3,000).");
});

// ─── The stand-in platform ────────────────────────────────────────────────────

/** What the family paid through the chat, per party: the platform's paid requests. Absent: none. */
const paidThroughChat = new Map<string, PartyDepositRequest[]>();
let platformDown = false;
const askedOf: string[] = [];
const platform = createServer((req: IncomingMessage, res: ServerResponse) => {
  const eventId = /\/otoapp\/parties\/([^/]+)\/deposit-request$/.exec(req.url ?? "")?.[1] ?? "";
  askedOf.push(eventId);
  if (platformDown) return void req.socket.destroy();
  const history = paidThroughChat.get(eventId) ?? [];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ eventId, hasConversation: true, current: history[0] ?? null, history }));
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;

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
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-840-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)", [
    branch, tenant, `ZZ TEST ${label} park ${run}`, linked ? randomUUID() : null,
  ]);
  return { tenant, branch };
}
async function user(g: { tenant: string }, role: string) {
  const id = randomUUID();
  const email = `zz-840-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
     values ($1, $2, $3, $4, $5, true, false, true)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [g.tenant, id]);
  return { id, email };
}
async function party(g: { tenant: string; branch: string }, title: string) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status, inbox_conversation_id)
     values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming', $5)`,
    [id, g.tenant, g.branch, `ZZ TEST 840 ${title} ${run}`, randomUUID()],
  );
  return id;
}

const A = await parkGroup("a", true);
const unlinked = await parkGroup("unlinked", false);
const adminA = await user(A, "admin");
const adminU = await user(unlinked, "admin");
const directoryKey = generateDirectoryKey();
await q("insert into directory_clients (tenant_id, name, key_hash, scopes, is_active) values ($1, $2, $3, $4, true)", [
  A.tenant, `ZZ TEST 840 platform ${run}`, hashDirectoryKey(directoryKey), ["events:write"],
]);

// ─── The app ──────────────────────────────────────────────────────────────────

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
      LOG_LEVEL: "error",
      TZ: "UTC",
      USE_AWS_REKOGNITION: "false",
      OTOAPP_LEGACY_LOGIN: "true",
      SESSION_SECRET: randomBytes(24).toString("hex"),
      PLATFORM_API_URL,
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

try {
  const origin = await serve({ OTOAPP_PROVISION_KEY: "zz-840-key" });
  const call = async (method: string, path: string, o: { cookie?: string; bearer?: string; body?: unknown } = {}) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(o.body ?? {}),
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
  const show = (r: { status: number; body: unknown }) => `${r.status} ${JSON.stringify(r.body)}`;
  const signIn = async (email: string) => {
    const login = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email, password: PASSWORD }),
    });
    assert.equal(login.status, 200, `sign-in: ${login.status}`);
    return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };
  const cookie = await signIn(adminA.email);
  const cookieU = await signIn(adminU.email);

  /** The deposit in every place the app keeps it, as the till's view reads it, and the BEO's read. */
  const homes = async (eventId: string, as = cookie) => {
    const [ev] = await q<{ prepayment_amount: number | null; prepayment_date: string | null; decoration: string | null }>(
      "select prepayment_amount, prepayment_date, decoration from core_events where id = $1", [eventId]);
    const [bl] = await q<{ deposit_paid: boolean | null; deposit_paid_amount: number | null; paid_on: string | null; pd: Record<string, unknown> | null }>(
      "select deposit_paid, deposit_paid_amount, deposit_paid_at::date::text as paid_on, add_ons -> 'partyDetails' as pd from beo_event_billing where event_id = $1",
      [eventId]);
    const [view] = await q<{ d: number | null }>("select deposit_satang::integer as d from otoapp_v.events where id = $1", [eventId]);
    const beo = await call("GET", `/api/events/${eventId}/beo`, { cookie: as });
    assert.equal(beo.status, 200, show(beo));
    return {
      event: [ev!.prepayment_amount, ev!.prepayment_date],
      billing: bl ? [bl.deposit_paid === true, bl.deposit_paid_amount, bl.paid_on] : null,
      partyDetails: bl?.pd ? [bl.pd.prepaymentReceived ?? null, bl.pd.depositDate ?? null] : null,
      till: view?.d ?? null,
      read: beo.body.oneDeposit,
      shown: beo.body.partyDetails ? [beo.body.partyDetails.prepaymentReceived ?? null, beo.body.partyDetails.depositDate ?? null] : null,
      decoration: ev!.decoration,
      pd: bl?.pd ?? null,
    };
  };
  const PAID = { event: [3000, DAY], billing: [true, 3000, DAY], partyDetails: [3000, DAY], till: 300_000, read: { amountThb: 3000, date: DAY }, shown: [3000, DAY] };
  const depositOf = async (eventId: string, as = cookie) => {
    const { decoration: _d, pd: _pd, ...deposit } = await homes(eventId, as);
    return deposit;
  };
  /** The platform's write-back of a gateway-paid deposit (SCRUM-825), as its directory client sends it. */
  const gatewayFact = (eventId: string, amountThb: number, day = DAY) =>
    call("POST", `/api/directory/events/${eventId}/edits`, {
      bearer: directoryKey,
      body: { id: randomUUID(), editedAt: "2000-01-01T00:00:00Z", fields: { prepaymentAmountThb: amountThb, prepaymentDate: day }, fact: "gateway_deposit" },
    });
  /** The BEO as a person opens it: the read, and a Save of that form with what they changed. */
  const openBeo = async (eventId: string, as = cookie) => {
    const read = await call("GET", `/api/events/${eventId}/beo`, { cookie: as });
    assert.equal(read.status, 200, show(read));
    return read.body as { oneDeposit: { amountThb: number; date: string | null }; partyDetails: Record<string, unknown> | null };
  };
  const saveBeo = (eventId: string, body: Record<string, unknown>, as = cookie) => call("PUT", `/api/events/${eventId}/beo`, { cookie: as, body: { billing: {}, ...body } });
  /** A party the BEO was saved on once (it keeps a billing row), with no deposit. */
  const partyWithBilling = async (title: string) => {
    const id = await party(A, title);
    const made = await saveBeo(id, { partyDetails: { packageName: "ZZ TEST", notes: "" }, expectedDeposit: { amountThb: 0, date: null } });
    assert.equal(made.status, 200, show(made));
    return id;
  };

  await check("THE RACE: the BEO open with no deposit, the family pays ฿3,000 through the chat, the stale form is saved — the deposit stays ฿3,000 everywhere, the other fields are saved, the answer says so", async () => {
    const asked = askedOf.length;
    // 1. A party the BEO keeps a billing row for; the form as this build sends it: its old figure, and that nobody changed it.
    const withRow = await partyWithBilling("race");
    const form = await openBeo(withRow);
    assert.deepEqual(form.oneDeposit, { amountThb: 0, date: null });
    const fact = await gatewayFact(withRow, 3000);
    assert.equal(fact.status, 200, show(fact));
    assert.deepEqual(await depositOf(withRow), PAID);
    const saved = await saveBeo(withRow, {
      event: { decoration: "ZZ TEST balloons" },
      partyDetails: { packageName: "ZZ TEST renamed", packageBasePrice: 0, items: [], prepaymentReceived: 0, depositDate: "", notes: "ZZ TEST note" },
      depositChanged: false,
      expectedDeposit: form.oneDeposit,
    });
    assert.equal(saved.status, 200, show(saved));
    assert.deepEqual(saved.body.depositSave, { kept: true, reason: "moved", amountThb: 3000, date: DAY, message: MOVED_3000 });
    assert.deepEqual(saved.body.oneDeposit, { amountThb: 3000, date: DAY });
    const after = await homes(withRow);
    assert.deepEqual({ event: after.event, billing: after.billing, partyDetails: after.partyDetails, till: after.till, read: after.read, shown: after.shown }, PAID);
    assert.equal(after.decoration, "ZZ TEST balloons", "the form's other fields are saved");
    assert.equal(after.pd?.packageName, "ZZ TEST renamed");
    assert.equal(after.pd?.notes, "ZZ TEST note");

    // 2. The stale form carrying its old figure (0 and no day), as a form that names the deposit sends it.
    const stale = await partyWithBilling("race-stale-figure");
    const staleForm = await openBeo(stale);
    assert.equal((await gatewayFact(stale, 3000)).status, 200);
    const cleared = await saveBeo(stale, {
      event: { decoration: "ZZ TEST streamers" },
      partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 0, depositDate: "", notes: "" },
      expectedDeposit: staleForm.oneDeposit,
    });
    assert.equal(cleared.status, 200, show(cleared));
    assert.equal(cleared.body.depositSave?.reason, "moved");
    assert.equal(cleared.body.depositSave?.message, MOVED_3000);
    assert.deepEqual(await depositOf(stale), PAID);
    assert.equal((await homes(stale)).decoration, "ZZ TEST streamers");

    // 3. The stale form that ALSO typed a figure (฿1,000 cash, say): kept too, and said — the person
    //    reads the paid deposit and types again on it.
    const typed = await partyWithBilling("race-typed");
    const typedForm = await openBeo(typed);
    assert.equal((await gatewayFact(typed, 3000)).status, 200);
    const both = await saveBeo(typed, {
      partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 1000, depositDate: "2099-03-01", notes: "" },
      expectedDeposit: typedForm.oneDeposit,
    });
    assert.equal(both.status, 200, show(both));
    assert.deepEqual(both.body.depositSave, { kept: true, reason: "moved", amountThb: 3000, date: DAY, message: MOVED_3000 });
    assert.deepEqual(await depositOf(typed), PAID);
    //    Typed again on the fresh read, it is written.
    const fresh = await openBeo(typed);
    const added = await saveBeo(typed, { partyDetails: { ...fresh.partyDetails, prepaymentReceived: 4000 }, expectedDeposit: fresh.oneDeposit });
    assert.equal(added.status, 200, show(added));
    assert.equal(added.body.depositSave, undefined);
    assert.deepEqual(added.body.oneDeposit, { amountThb: 4000, date: DAY });
    assert.equal((await depositOf(typed)).till, 400_000);

    // 4. A party the BEO never saved (no billing row): the event's own deposit is the one deposit, and stays.
    const bare = await party(A, "race-no-row");
    const bareForm = await openBeo(bare);
    assert.equal((await gatewayFact(bare, 3000)).status, 200);
    const first = await saveBeo(bare, {
      partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 0, depositDate: "", notes: "" },
      expectedDeposit: bareForm.oneDeposit,
    });
    assert.equal(first.status, 200, show(first));
    assert.equal(first.body.depositSave?.reason, "moved");
    assert.deepEqual(await depositOf(bare), PAID, "the billing row this Save made holds the paid deposit in all its places");

    // 5. A page loaded before this rule sends no `expectedDeposit`: its 0 is not trusted to be deliberate.
    const old = await partyWithBilling("race-old-page");
    assert.equal((await gatewayFact(old, 3000)).status, 200);
    const oldSave = await saveBeo(old, { event: { decoration: "ZZ TEST old page" }, partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 0, depositDate: "", notes: "" } });
    assert.equal(oldSave.status, 200, show(oldSave));
    assert.equal(oldSave.body.depositSave?.reason, "unconfirmed");
    assert.match(oldSave.body.depositSave.message, /was not lowered \(it stays ฿3,000\): this page is out of date/);
    assert.deepEqual(await depositOf(old), PAID);
    assert.equal((await homes(old)).decoration, "ZZ TEST old page");
    //    …while a raise from such a page is written, as before the rule.
    const oldRaise = await saveBeo(old, { partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 3500, depositDate: DAY, notes: "" } });
    assert.equal(oldRaise.body.depositSave, undefined, show(oldRaise));
    assert.equal((await depositOf(old)).till, 350_000);

    // 6. A form that says it did not change the deposit names none, whatever figure travels with it —
    //    even from a form that does not say which deposit it was opened with.
    const untouched = await partyWithBilling("race-untouched");
    assert.equal((await gatewayFact(untouched, 3000)).status, 200);
    const quiet = await saveBeo(untouched, { partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 0, depositDate: "", notes: "" }, depositChanged: false });
    assert.equal(quiet.status, 200, show(quiet));
    assert.equal(quiet.body.depositSave, undefined, "nothing was carried, so nothing is said");
    assert.deepEqual(quiet.body.oneDeposit, { amountThb: 3000, date: DAY });
    assert.deepEqual(await depositOf(untouched), PAID);
    //    …and a form with no Party Details' deposit at all names none either.
    const bareForm2 = await saveBeo(untouched, { partyDetails: { packageName: "ZZ TEST 2", notes: "" } });
    assert.equal(bareForm2.status, 200, show(bareForm2));
    assert.deepEqual(await depositOf(untouched), PAID);

    // 7. The event's own fields of the Save never carry the deposit.
    const viaEvent = await partyWithBilling("race-event-fields");
    const viaForm = await openBeo(viaEvent);
    assert.equal((await gatewayFact(viaEvent, 3000)).status, 200);
    const sneaked = await saveBeo(viaEvent, { event: { prepaymentAmount: null, prepaymentDate: null, decoration: "ZZ TEST" }, expectedDeposit: viaForm.oneDeposit });
    assert.equal(sneaked.status, 200, show(sneaked));
    assert.deepEqual(await depositOf(viaEvent), PAID);

    assert.equal(askedOf.length, asked, "a stale Save is kept without asking the platform anything");
  });

  await check("the fact and the stale Save sent together: whichever lands first, the deposit is ฿3,000", async () => {
    for (let i = 0; i < 6; i += 1) {
      const id = await partyWithBilling(`together-${i}`);
      const form = await openBeo(id);
      const stale = { partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 0, depositDate: "", notes: "" }, expectedDeposit: form.oneDeposit };
      // Odd rounds send the fact first, even rounds the Save first.
      const sentFirst = i % 2 ? gatewayFact(id, 3000) : saveBeo(id, stale);
      const sentSecond = i % 2 ? saveBeo(id, stale) : gatewayFact(id, 3000);
      const [fact, saved] = i % 2 ? await Promise.all([sentFirst, sentSecond]) : (await Promise.all([sentFirst, sentSecond])).reverse();
      assert.equal(fact.status, 200, show(fact));
      assert.equal(saved.status, 200, show(saved));
      assert.deepEqual(await depositOf(id), PAID, `round ${i}`);
    }
  });

  await check("a deliberate change from a fresh form is written; lowered below what the chat paid it is kept and said; the platform is asked only for a lowering", async () => {
    const id = await partyWithBilling("deliberate");
    const paid = paidRequest(id, 300_000);
    paidThroughChat.set(id, [paid]);
    assert.equal((await gatewayFact(id, 3000)).status, 200);
    let asked = askedOf.length;

    // Raised to ฿4,000 (a cash top-up typed in Party Details): written, nobody asked.
    let form = await openBeo(id);
    assert.deepEqual(form.oneDeposit, { amountThb: 3000, date: DAY });
    const raised = await saveBeo(id, { partyDetails: { ...form.partyDetails, prepaymentReceived: 4000 }, expectedDeposit: form.oneDeposit });
    assert.equal(raised.status, 200, show(raised));
    assert.equal(raised.body.depositSave, undefined);
    assert.deepEqual(await depositOf(id), {
      event: [4000, DAY], billing: [true, 4000, DAY], partyDetails: [4000, DAY], till: 400_000, read: { amountThb: 4000, date: DAY }, shown: [4000, DAY],
    });
    assert.equal(askedOf.length, asked, "a raise asks the platform nothing");

    // Lowered to ฿3,500, still above the chat's ฿3,000: written, the platform asked once.
    form = await openBeo(id);
    const lowered = await saveBeo(id, { partyDetails: { ...form.partyDetails, prepaymentReceived: 3500 }, expectedDeposit: form.oneDeposit });
    assert.equal(lowered.status, 200, show(lowered));
    assert.equal(lowered.body.depositSave, undefined);
    assert.equal((await depositOf(id)).till, 350_000);
    assert.deepEqual(askedOf.slice(asked), [id]);
    asked = askedOf.length;

    // Lowered to ฿2,000, or cleared: below what the family paid through the chat. Kept and said; the rest saved.
    for (const figure of [2000, 0]) {
      form = await openBeo(id);
      const below = await saveBeo(id, {
        event: { decoration: `ZZ TEST below ${figure}` },
        partyDetails: { ...form.partyDetails, prepaymentReceived: figure, ...(figure === 0 ? { depositDate: "" } : {}) },
        expectedDeposit: form.oneDeposit,
      });
      assert.equal(below.status, 200, show(below));
      assert.equal(below.body.depositSave?.reason, "gateway");
      assert.equal(
        below.body.depositSave.message,
        "฿3,000 of this deposit was paid through the chat, so Save does not lower it below that (it stays ฿3,500). Your other changes were saved. A paid deposit is corrected in the BEO's Billing section (Deposit Paid).",
      );
      assert.deepEqual(below.body.oneDeposit, { amountThb: 3500, date: DAY });
      const after = await homes(id);
      assert.equal(after.till, 350_000);
      assert.deepEqual(after.partyDetails, [3500, DAY]);
      assert.equal(after.decoration, `ZZ TEST below ${figure}`);
    }
    assert.equal(askedOf.length, asked + 2);

    // The platform does not answer: the deposit is not lowered on a guess.
    platformDown = true;
    form = await openBeo(id);
    const unchecked = await saveBeo(id, { partyDetails: { ...form.partyDetails, prepaymentReceived: 3200 }, expectedDeposit: form.oneDeposit });
    platformDown = false;
    assert.equal(unchecked.status, 200, show(unchecked));
    assert.equal(unchecked.body.depositSave?.reason, "unchecked");
    assert.match(unchecked.body.depositSave.message, /was not lowered \(it stays ฿3,500\): the till could not be asked/);
    assert.equal((await depositOf(id)).till, 350_000);

    // A party the chat paid nothing for: a deposit typed by staff is lowered and cleared from a fresh form, as before the rule.
    const cash = await partyWithBilling("deliberate-cash");
    form = await openBeo(cash);
    assert.equal((await saveBeo(cash, { partyDetails: { ...form.partyDetails, prepaymentReceived: 2500, depositDate: "2099-03-01" }, expectedDeposit: form.oneDeposit })).status, 200);
    assert.equal((await depositOf(cash)).till, 250_000);
    form = await openBeo(cash);
    const less = await saveBeo(cash, { partyDetails: { ...form.partyDetails, prepaymentReceived: 1500 }, expectedDeposit: form.oneDeposit });
    assert.equal(less.body.depositSave, undefined, show(less));
    assert.equal((await depositOf(cash)).till, 150_000);
    form = await openBeo(cash);
    const none = await saveBeo(cash, { partyDetails: { ...form.partyDetails, prepaymentReceived: 0, depositDate: "" }, expectedDeposit: form.oneDeposit });
    assert.equal(none.body.depositSave, undefined, show(none));
    assert.deepEqual(none.body.oneDeposit, { amountThb: 0, date: null });
    const gone = await depositOf(cash);
    assert.deepEqual([gone.event, gone.billing, gone.till], [[null, null], [false, null, null], null]);

    // A park not linked to the till has no chat payments: a deliberate lowering is written without asking.
    asked = askedOf.length;
    const away = await party(unlinked, "deliberate-unlinked");
    let awayForm = await openBeo(away, cookieU);
    assert.equal((await saveBeo(away, { partyDetails: { packageName: "ZZ TEST", prepaymentReceived: 2000, depositDate: DAY, notes: "" }, expectedDeposit: awayForm.oneDeposit }, cookieU)).status, 200);
    awayForm = await openBeo(away, cookieU);
    const awayLess = await saveBeo(away, { partyDetails: { ...awayForm.partyDetails, prepaymentReceived: 500 }, expectedDeposit: awayForm.oneDeposit }, cookieU);
    assert.equal(awayLess.body.depositSave, undefined, show(awayLess));
    assert.deepEqual((await depositOf(away, cookieU)).read, { amountThb: 500, date: DAY });
    assert.equal(askedOf.length, asked);
  });

  await check("the Billing section's Deposit Paid, sent with the deposit it showed: one that moved is kept and said, a deliberate figure is written", async () => {
    const id = await partyWithBilling("billing");
    const billing = (path = "") => `/api/events/${id}/beo/billing${path}`;
    const showed = (await openBeo(id)).oneDeposit;
    assert.equal((await gatewayFact(id, 3000)).status, 200);
    // ฿1,000 typed over the 0 the section still showed, with a deposit required beside it.
    const stale = await call("PUT", billing(), { cookie, body: { depositPaid: true, depositPaidAmount: 1000, depositRequired: true, depositAmount: 5000, expectedDeposit: showed } });
    assert.equal(stale.status, 200, show(stale));
    assert.deepEqual(stale.body.depositSave, { kept: true, reason: "moved", amountThb: 3000, date: DAY, message: MOVED_3000 });
    assert.deepEqual(stale.body.oneDeposit, { amountThb: 3000, date: DAY });
    assert.equal(stale.body.depositAmount, 5000, "the write's other fields are saved");
    assert.equal(stale.body.depositPaidAmount, 3000);
    assert.deepEqual(await depositOf(id), PAID);
    // The deposit alone, stale: nothing is written at all, and the answer still says the deposit.
    const only = await call("PUT", billing(), { cookie, body: { depositPaid: true, depositPaidAmount: 1000, expectedDeposit: showed } });
    assert.equal(only.status, 200, show(only));
    assert.equal(only.body.depositSave?.reason, "moved");
    assert.deepEqual(await depositOf(id), PAID);
    // Typed on the figure the section now shows: written to every place (a manager's own correction of the deposit).
    const typed = await call("PUT", billing(), { cookie, body: { depositPaid: true, depositPaidAmount: 2500, expectedDeposit: stale.body.oneDeposit } });
    assert.equal(typed.status, 200, show(typed));
    assert.equal(typed.body.depositSave, undefined);
    assert.deepEqual(typed.body.oneDeposit, { amountThb: 2500, date: DAY });
    assert.deepEqual(await depositOf(id), {
      event: [2500, DAY], billing: [true, 2500, DAY], partyDetails: [2500, DAY], till: 250_000, read: { amountThb: 2500, date: DAY }, shown: [2500, DAY],
    });
    // A write that says no `expectedDeposit` is written as it always was.
    const plain = await call("PUT", billing(), { cookie, body: { depositPaid: true, depositPaidAmount: 2600 } });
    assert.equal(plain.status, 200, show(plain));
    assert.equal((await depositOf(id)).till, 260_000);
    const [columns] = await q<Record<string, unknown>>("select * from beo_event_billing where event_id = $1", [id]);
    assert.ok(!("expectedDeposit" in columns!) && !("expected_deposit" in columns!));
    // On a party with no billing row, a stale deposit alone makes no row.
    const bare = await party(A, "billing-no-row");
    const bareShowed = (await openBeo(bare)).oneDeposit;
    assert.equal((await gatewayFact(bare, 3000)).status, 200);
    const none = await call("PUT", `/api/events/${bare}/beo/billing`, { cookie, body: { depositPaid: true, depositPaidAmount: 1000, expectedDeposit: bareShowed } });
    assert.equal(none.status, 200, show(none));
    assert.equal(none.body.depositSave?.reason, "moved");
    assert.deepEqual(none.body.oneDeposit, { amountThb: 3000, date: DAY });
    assert.equal((await q("select 1 from beo_event_billing where event_id = $1", [bare])).length, 0);
    assert.equal((await depositOf(bare)).till, 300_000);
    // …and a stale deposit beside another field makes the row with the PAID deposit in it, the event's own untouched.
    const withField = await call("PUT", `/api/events/${bare}/beo/billing`, { cookie, body: { depositPaid: true, depositPaidAmount: 1000, depositRequired: true, depositAmount: 5000, expectedDeposit: bareShowed } });
    assert.equal(withField.status, 201, show(withField));
    assert.equal(withField.body.depositSave?.reason, "moved");
    assert.equal(withField.body.depositAmount, 5000);
    assert.equal(withField.body.depositPaidAmount, 3000);
    assert.deepEqual(await depositOf(bare), PAID);
  });

  await check("the Events page's Save: a deposit that moved while the form was open stays, its other fields are saved; a deliberate change is written", async () => {
    const id = await partyWithBilling("events-page");
    const patch = (body: Record<string, unknown>) => call("PATCH", `/api/admin/events/${id}`, { cookie, body });
    const listed = async () => {
      const list = await call("GET", "/api/admin/events?range=all", { cookie });
      assert.equal(list.status, 200, show(list));
      const row = (list.body as Array<{ id: string; prepaymentAmount: number | null; prepaymentDate: string | null }>).find((e) => e.id === id)!;
      return { amountThb: row.prepaymentAmount ?? 0, date: row.prepaymentDate ?? null };
    };
    const opened = await listed();
    assert.deepEqual(opened, { amountThb: 0, date: null });
    assert.equal((await gatewayFact(id, 3000)).status, 200);
    // The form as the Events page sends it: every field, the Prepayment it was opened with among them.
    const stale = await patch({ prepaymentAmount: null, prepaymentDate: null, decoration: "ZZ TEST from the events page", expectedPrepayment: opened });
    assert.equal(stale.status, 200, show(stale));
    assert.deepEqual(stale.body.depositSave, {
      kept: true, reason: "moved", amountThb: 3000, date: DAY,
      message: "The deposit changed while this event was open (now ฿3,000). Your other changes were saved.",
    });
    assert.equal(stale.body.decoration, "ZZ TEST from the events page");
    assert.equal(stale.body.prepaymentAmount, 3000);
    assert.deepEqual(await depositOf(id), PAID);
    // A page from before the rule lowering it: kept. Raising it: written.
    const old = await patch({ prepaymentAmount: null, prepaymentDate: null });
    assert.equal(old.body.depositSave?.reason, "unconfirmed", show(old));
    assert.deepEqual(await depositOf(id), PAID);
    // Opened again and changed on purpose: written to the event and the BEO.
    const fresh = await listed();
    assert.deepEqual(fresh, { amountThb: 3000, date: DAY });
    const raised = await patch({ prepaymentAmount: 4500, prepaymentDate: "2099-03-06", expectedPrepayment: fresh });
    assert.equal(raised.status, 200, show(raised));
    assert.equal(raised.body.depositSave, undefined);
    assert.equal(raised.body.prepaymentAmount, 4500);
    assert.deepEqual(await depositOf(id), {
      event: [4500, "2099-03-06"], billing: [true, 4500, "2099-03-06"], partyDetails: [4500, "2099-03-06"], till: 450_000,
      read: { amountThb: 4500, date: "2099-03-06" }, shown: [4500, "2099-03-06"],
    });
    // Lowered on purpose below the chat's ฿3,000: kept and said; to ฿3,000 itself: written.
    paidThroughChat.set(id, [paidRequest(id, 300_000)]);
    const now = await listed();
    const below = await patch({ prepaymentAmount: 1000, prepaymentDate: "2099-03-06", decoration: "ZZ TEST again", expectedPrepayment: now });
    assert.equal(below.body.depositSave?.reason, "gateway", show(below));
    assert.equal(below.body.decoration, "ZZ TEST again");
    assert.equal((await depositOf(id)).till, 450_000);
    const toFloor = await patch({ prepaymentAmount: 3000, prepaymentDate: "2099-03-06", expectedPrepayment: now });
    assert.equal(toFloor.body.depositSave, undefined, show(toFloor));
    assert.equal((await depositOf(id)).till, 300_000);
    // A Save that names no Prepayment at all (the day-of view's notes, a branch change) is as it was.
    const notes = await patch({ decoration: "ZZ TEST notes only" });
    assert.equal(notes.status, 200, show(notes));
    assert.equal(notes.body.depositSave, undefined);
    assert.equal((await depositOf(id)).till, 300_000);
  });

  await check("nobody else is in the way: a till's party edit still lowers the deposit, and the gateway fact lands over a Save made since", async () => {
    const id = await partyWithBilling("others");
    paidThroughChat.set(id, [paidRequest(id, 300_000)]);
    assert.equal((await gatewayFact(id, 3000)).status, 200);
    // A till's party edit (an admin's deliberate correction there): written, below the chat's payment too.
    const till = await call("POST", `/api/directory/events/${id}/edits`, {
      bearer: directoryKey,
      body: { id: randomUUID(), editedAt: new Date(Date.now() + 5_000).toISOString(), fields: { prepaymentAmountThb: 1000, prepaymentDate: DAY } },
    });
    assert.equal(till.status, 200, show(till));
    assert.equal((await depositOf(id)).till, 100_000);
    // A BEO Save since, then the family's second payment: the fact lands whatever was saved.
    const form = await openBeo(id);
    assert.equal((await saveBeo(id, { event: { decoration: "ZZ TEST later" }, partyDetails: { ...form.partyDetails }, expectedDeposit: form.oneDeposit })).status, 200);
    const second = await gatewayFact(id, 6000, "2099-03-03");
    assert.equal(second.status, 200, show(second));
    assert.equal(second.body.replayed, false);
    assert.deepEqual(await depositOf(id), {
      event: [6000, "2099-03-03"], billing: [true, 6000, "2099-03-03"], partyDetails: [6000, "2099-03-03"], till: 600_000,
      read: { amountThb: 6000, date: "2099-03-03" }, shown: [6000, "2099-03-03"],
    });
  });

  console.log(`deposit-save.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
process.exit(checks === 7 ? 0 : 1);
