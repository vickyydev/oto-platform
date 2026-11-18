// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) and a
// stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built.
//
// SCRUM-1002, the owner's ruling 3 of 18 November 2026 ("Refuse both: a paid
// item stays"): a BEO line already billed and paid can be neither lowered
// below its paid count nor deleted (shared/beoPaidLines.ts):
//
//   - the till says, line by line, how many it billed and how many of those
//     are paid (`beoLines` of GET /otoapp/parties/:eventId/billing); only the
//     lines the additional bill counts are held, never a set-menu dish or a
//     line included in the package;
//   - the BEO's Save, from any client: a paid line lowered below its paid
//     count or deleted stays as stored, on the kitchen's lists and the bar's
//     alike, the answer names it, and the rest of the Save is written;
//     turning "Different for adults" off with a paid adults' line keeps the
//     switch and that list; the day-of view's kitchen plan write
//     (PUT /api/events/:eventId/beo/kitchen-plan) keeps such a line too;
//   - the two other doors keep it the same way, with the same answer
//     (`paidLinesKept`): the till's own kitchen-plan edit
//     (POST /api/directory/events/:id/kitchen-plan), a lowered or removed paid
//     line kept, the rest of the edit written, a replay answering the same;
//     and the AI fill's approval (POST /api/events/:eventId/beo/ai-fill/approve),
//     a reviewed line lowering a paid one kept while the rest of the approval
//     is written — never the whole approval refused;
//   - a raise goes through and reaches the till at its new count; a line
//     billed on a bill not yet paid, or not billed, is lowered and removed as
//     before; the till not answering leaves the Save as sent.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/beo-paid-lines.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { BEO_PAID_LINE_REFUSAL, keepPaidBeoLines, paidLinesKeptWords, paidLinesOf, paidQuantitiesOf } from "../shared/beoPaidLines";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-paid-lines.check: DATABASE_URL is not set");
  process.exit(2);
}
process.env.APP_ENV ??= "dev";
process.env.STORAGE_ENV_PREFIX ??= "zz-test-1002";
process.env.OBJECT_STORAGE ??= "local";
process.env.DEPLOY_ENV ??= "local";
process.env.SESSION_SECRET ??= randomBytes(24).toString("hex");
process.env.LOG_LEVEL ??= "warn";
// The AI fill's approval is sent against the plan as saved, as the review reads it.
const { beoReviewState } = await import("../server/lib/beoReviewState");
const { db: appDb, pool: appDbPool } = await import("../server/db");

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

type Line = { id: string; itemName: string; quantity: number; notes: string; included: boolean; price: number; source?: string; chargeApproved?: boolean; billingSync?: string };
const extra = (id: string, name: string, quantity: number, over: Partial<Line> = {}): Line => ({
  id, itemName: `ZZ TEST ${name}`, quantity, notes: "", included: false, price: 100, source: "additional", chargeApproved: true, ...over,
});
const k1 = extra("k1", "paid pizza", 2);
const k2 = extra("k2", "open-bill fries", 2);
const k3 = extra("k3", "unbilled juice", 1);
const k4 = extra("k4", "free cake", 1, { included: true, price: 0 });
const s1: Line = { id: "s1", itemName: "ZZ TEST set rice", quantity: 10, notes: "", included: true, price: 0, source: "set_menu" };
const a1 = extra("a1", "adults satay", 1);
const b1 = extra("b1", "paid cola", 2, { source: undefined });
const b2 = extra("b2", "open-bill tea", 2, { source: undefined });
/** What the till answers once the party is settled: the main receipt's lines and the additional bills', paid or not. */
const TILL_LINES = [
  { lineId: "k1", billedQuantity: 2, paidQuantity: 2 },
  { lineId: "k2", billedQuantity: 2, paidQuantity: 0 },
  { lineId: "k4", billedQuantity: 1, paidQuantity: 1 },
  { lineId: "s1", billedQuantity: 10, paidQuantity: 10 },
  { lineId: "a1", billedQuantity: 1, paidQuantity: 1 },
  { lineId: "b1", billedQuantity: 2, paidQuantity: 2 },
  { lineId: "b2", billedQuantity: 2, paidQuantity: 0 },
];

// ─── The rule, on its own ────────────────────────────────────────────────────

await check("the rule: the till's paid counts; held only the lines the additional bill counts, never a set dish or an included one", () => {
  const paid = paidQuantitiesOf([...TILL_LINES, { lineId: "x", billedQuantity: 1, paidQuantity: 0 }, { lineId: 3, paidQuantity: 1 }, null]);
  assert.deepEqual([...paid], [["k1", 2], ["k4", 1], ["s1", 10], ["a1", 1], ["b1", 2]]);
  const menus = { kids: [k1, k2, k3, k4, s1], adults: [a1], adultsDiffer: true };
  assert.deepEqual([...paidLinesOf(menus, [b1, b2], paid)], [["k1", 2], ["a1", 1], ["b1", 2]]);
  // The adults' copy of a kids' line is billed with it, so is never held on its own.
  assert.deepEqual([...paidLinesOf({ kids: [k1], adults: [{ ...k1, id: "a_copy" }], adultsDiffer: true }, [], new Map([["a_copy", 2], ["k1", 2]]))], [["k1", 2]]);
  assert.equal(paidLinesOf(menus, [b1], new Map()).size, 0, "nothing paid: nothing held");
});

await check("the rule: lowered below its paid count or deleted, a paid line is kept as stored, in its place; lowered to it, raised, or another line changed, the Save stands", () => {
  const paid = paidQuantitiesOf(TILL_LINES);
  const stored = { menus: { kids: [k1, k2, k3], adults: [a1], adultsDiffer: true }, barItems: [b1, b2] };
  const lowered = keepPaidBeoLines(stored, { menus: { kids: [{ ...k1, quantity: 1 }, k3], adults: [a1], adultsDiffer: true, kidsFoodTime: "15:30" }, barItems: [{ ...b2, quantity: 1 }] }, paid);
  assert.deepEqual(lowered.menus?.kids, [k1, k3], "the pizza as stored; the unpaid fries removed");
  assert.equal(lowered.menus?.kidsFoodTime, "15:30", "the rest of the Save stands");
  assert.deepEqual(lowered.barItems, [b1, { ...b2, quantity: 1 }], "the paid cola back in its place; the unpaid tea lowered");
  assert.deepEqual(lowered.kept.map((l) => [l.id, l.list, l.paidQuantity]), [["k1", "kids", 2], ["b1", "bar", 2]]);
  const asText = { ...b1, quantity: "2" } as unknown as Line;
  const fine = keepPaidBeoLines(stored, { menus: { kids: [{ ...k1, quantity: 3 }], adults: [{ ...a1, notes: "no peanuts" }], adultsDiffer: true }, barItems: [asText] }, paid);
  assert.deepEqual(fine.kept, [], "a raise, a paid count as text, an adults' note: nothing kept");
  assert.deepEqual(fine.menus?.kids, [{ ...k1, quantity: 3 }]);
  const off = keepPaidBeoLines(stored, { menus: { kids: [k1, k2, k3], adults: [], adultsDiffer: false } }, paid);
  assert.equal(off.menus?.adultsDiffer, true, "the switch stays on");
  assert.deepEqual(off.menus?.adults, [a1], "the adults' list as stored");
  assert.deepEqual(off.kept.map((l) => [l.id, l.list]), [["a1", "adults"]]);
  assert.equal(off.barItems, undefined, "a list the Save does not write is left alone");
  assert.equal(paidLinesKeptWords(lowered.kept), "Kept as billed: ZZ TEST paid pizza (2 paid), ZZ TEST paid cola (2 paid). Everything else was saved.");
  assert.equal(BEO_PAID_LINE_REFUSAL, "Already billed and paid: this item cannot be reduced or removed.");
});

// ─── The stand-in platform ────────────────────────────────────────────────────

type Asked = { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
const additions: Asked[] = [];
const billingReads: string[] = [];
let tillDown = false;
const tillLines = new Map<string, unknown[]>();
const tillAnswer = (eventId: string) => ({
  additionalBills: [], eventId, state: "sale",
  park: { name: "ZZ TEST", branchName: "ZZ TEST park", address: null },
  party: { title: "ZZ TEST 1002", date: "2099-03-14", startTime: null, endTime: null, packageName: null, kids: 10, adults: 4 },
  quote: null, sale: null, noQuote: null,
  beoLines: tillLines.get(eventId) ?? [],
});
const platform = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url ?? "";
    const read = /^\/otoapp\/parties\/([^/]+)\/billing$/.exec(url);
    if (req.method === "GET" && read) {
      billingReads.push(read[1]!);
      res.writeHead(tillDown ? 502 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(tillDown ? { error: { code: "UPSTREAM", message: "ZZ TEST the till is down" } } : tillAnswer(read[1]!)));
      return;
    }
    if (/^\/otoapp\/parties\/[^/]+\/beo-additions$/.test(url)) {
      additions.push({ url, headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "synced", added: 0, billIds: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "ZZ TEST" } }));
  });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;

// ─── Rows ─────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const tenant = randomUUID();
const branch = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 1002 ${run}`, `zz-1002-${run}`]);
await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)", [branch, tenant, `ZZ TEST 1002 park ${run}`, randomUUID()]);
const adminId = randomUUID();
const adminEmail = `zz-1002-admin-${run}@example.com`;
const salt = randomBytes(16).toString("hex");
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
   values ($1, $2, $3, 'ZZ TEST admin', 'admin', true, false, true)`,
  [adminId, adminEmail, `${scryptSync(PASSWORD, salt, 64).toString("hex")}.${salt}`],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, adminId]);
// The platform's tenant-bound directory key the till's kitchen-plan door answers (server/directory/clientAuth.ts).
const DIRECTORY_KEY = `odk_${randomBytes(32).toString("base64url")}`;
await q("insert into directory_clients (tenant_id, name, key_hash, scopes, is_active) values ($1, $2, $3, $4, true)", [
  tenant, `ZZ TEST 1002 ${run} events:write`, createHash("sha256").update(DIRECTORY_KEY).digest("hex"), ["events:write"],
]);
async function party(title: string) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
     values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming')`,
    [id, tenant, branch, `ZZ TEST BEO 1002 ${title} ${run}`],
  );
  return id;
}
type Stored = { kids: Line[]; adults: Line[]; adultsDiffer: boolean; kidsFoodTime: string; bar: Line[] };
const storedOf = async (eventId: string): Promise<Stored> => {
  const [kitchen] = await q<{ menus: Record<string, unknown> }>("select menus from beo_kitchen_plans where event_id = $1", [eventId]);
  const [bar] = await q<{ items: Line[] }>("select items from beo_bar_plans where event_id = $1", [eventId]);
  const m = kitchen?.menus ?? {};
  return { kids: (m.kids as Line[]) ?? [], adults: (m.adults as Line[]) ?? [], adultsDiffer: m.adultsDiffer === true, kidsFoodTime: String(m.kidsFoodTime ?? ""), bar: bar?.items ?? [] };
};
const counts = (lines: Line[]) => lines.map((l) => [l.id, l.quantity]);

// ─── The app ──────────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
async function serve(): Promise<string> {
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
      SESSION_SECRET: randomBytes(24).toString("hex"),
      PLATFORM_API_URL,
      OTOAPP_PROVISION_KEY: "zz-1002-key",
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
  const origin = await serve();
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: adminEmail, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = async (method: string, path: string, payload?: unknown) => {
    const res = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", cookie }, body: method === "GET" ? undefined : JSON.stringify(payload ?? {}) });
    const text = await res.text();
    let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
    try {
      body = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, body };
  };
  /** The editor's Save: the kitchen's lists, and the bar's when given. */
  const save = (eventId: string, kitchen: { kids: Line[]; adults: Line[]; adultsDiffer: boolean; kidsFoodTime?: string }, bar?: Line[], more: Record<string, unknown> = {}) =>
    call("PUT", `/api/events/${eventId}/beo`, {
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null,
        menus: { kids: kitchen.kids, adults: kitchen.adults, adultsDiffer: kitchen.adultsDiffer, kidsFoodTime: kitchen.kidsFoodTime ?? "", adultsFoodTime: "" },
        serviceSchedule: [],
      },
      ...(bar ? { barPlan: { serviceTime: "14:00", items: bar } } : {}),
      ...more,
    });
  /** A settled party: its plan saved before any line was billed, then the till's counts. */
  const settledParty = async (title: string) => {
    const id = await party(title);
    const first = await save(id, { kids: [k1, k2, k3, k4, s1], adults: [a1], adultsDiffer: true }, [b1, b2]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.paidLinesKept, undefined);
    tillLines.set(id, TILL_LINES);
    return id;
  };
  const lastOffered = () => (additions.at(-1)!.body.lines as Array<{ lineId: string; quantity: number }>).map((l) => [l.lineId, l.quantity]);

  await check("a Save lowering a paid line below its paid count, or deleting one, keeps it as stored on the kitchen's list and the bar's, says so, and writes the rest", async () => {
    const id = await settledParty("lower and delete");
    const reads = billingReads.length;
    const res = await save(
      id,
      { kids: [{ ...k1, quantity: 1 }, { ...k3, quantity: 4 }], adults: [a1], adultsDiffer: true, kidsFoodTime: "15:30" },
      [{ ...b2, quantity: 1 }],
      { event: { internalStaffNotes: "ZZ TEST 1002 note" } },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(billingReads.length, reads + 1, "the till was asked once");
    assert.deepEqual(res.body.paidLinesKept, [
      { id: "k1", itemName: "ZZ TEST paid pizza", list: "kids", paidQuantity: 2 },
      { id: "b1", itemName: "ZZ TEST paid cola", list: "bar", paidQuantity: 2 },
    ]);
    const stored = await storedOf(id);
    // The paid pizza as stored; the fries on a bill not yet paid, the free cake and the set dish removed as asked.
    assert.deepEqual(counts(stored.kids), [["k1", 2], ["k3", 4]]);
    assert.deepEqual(counts(stored.bar), [["b1", 2], ["b2", 1]], "the paid cola back where it stood; the unpaid tea lowered");
    assert.equal(stored.kidsFoodTime, "15:30", "the rest of the Save written");
    const read = await call("GET", `/api/events/${id}/beo`);
    assert.equal(read.body.internalStaffNotes, "ZZ TEST 1002 note");
    assert.deepEqual(counts(read.body.kitchenPlan.menus.kids), [["k1", 2], ["k3", 4]], "the BEO's read is what is stored");
    // The till is never asked to bill the paid lines lower.
    assert.deepEqual(lastOffered(), [["k1", 2], ["k3", 4], ["a1", 1], ["b1", 2], ["b2", 1]]);
  });

  await check("turning Different for adults off with a paid adults' line keeps the switch and that list", async () => {
    const id = await settledParty("adults off");
    const res = await save(id, { kids: [k1, k2, k3, k4, s1], adults: [], adultsDiffer: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.paidLinesKept.map((l: { id: string; list: string }) => [l.id, l.list]), [["a1", "adults"]]);
    const stored = await storedOf(id);
    assert.equal(stored.adultsDiffer, true);
    assert.deepEqual(counts(stored.adults), [["a1", 1]]);
  });

  await check("a raise goes through and reaches the till at its new count; lowered back to its paid count is allowed", async () => {
    const id = await settledParty("raise");
    const raised = await save(id, { kids: [{ ...k1, quantity: 3 }, k2, k3], adults: [a1], adultsDiffer: true }, [{ ...b1, quantity: 3 }, b2]);
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.equal(raised.body.paidLinesKept, undefined);
    assert.deepEqual(counts((await storedOf(id)).kids), [["k1", 3], ["k2", 2], ["k3", 1]]);
    assert.deepEqual(lastOffered().filter(([lineId]) => lineId === "k1" || lineId === "b1"), [["k1", 3], ["b1", 3]], "the till is offered the raised counts to bill");
    const back = await save(id, { kids: [{ ...k1, quantity: 2 }, k2, k3], adults: [a1], adultsDiffer: true }, [{ ...b1, quantity: 2 }, b2]);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.paidLinesKept, undefined, "the paid count itself is never refused");
    assert.deepEqual(counts((await storedOf(id)).bar), [["b1", 2], ["b2", 2]]);
  });

  await check("a line billed on a bill not yet paid, or not billed, is lowered and removed as before; nothing paid, nothing kept", async () => {
    const id = await settledParty("unpaid");
    const res = await save(id, { kids: [k1, { ...k2, quantity: 1 }], adults: [a1], adultsDiffer: true }, [b1]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.paidLinesKept, undefined);
    const stored = await storedOf(id);
    assert.deepEqual(counts(stored.kids), [["k1", 2], ["k2", 1]]);
    assert.deepEqual(counts(stored.bar), [["b1", 2]]);
    // A party the till has billed nothing for: no line held whatever the Save does.
    const fresh = await party("not settled");
    assert.equal((await save(fresh, { kids: [k1], adults: [], adultsDiffer: false })).status, 200);
    const cleared = await save(fresh, { kids: [], adults: [], adultsDiffer: false });
    assert.equal(cleared.body.paidLinesKept, undefined);
    assert.deepEqual((await storedOf(fresh)).kids, []);
  });

  await check("the day-of view's kitchen plan write keeps a paid line as the Save does, and says so", async () => {
    const id = await settledParty("day of");
    const res = await call("PUT", `/api/events/${id}/beo/kitchen-plan`, { menus: { kids: [k2, k3], adults: [a1], adultsDiffer: true, kidsFoodTime: "16:00", adultsFoodTime: "" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.paidLinesKept.map((l: { id: string; list: string }) => [l.id, l.list]), [["k1", "kids"]]);
    const stored = await storedOf(id);
    assert.deepEqual(counts(stored.kids), [["k1", 2], ["k2", 2], ["k3", 1]], "the paid pizza back where it stood");
    assert.equal(stored.kidsFoodTime, "16:00", "the rest of the write stands");
  });

  /** The till's own kitchen-plan edit, as the platform sends it under its directory key. */
  const tillEdit = async (eventId: string, changes: unknown[], id: string = randomUUID()) => {
    const res = await fetch(`${origin}/api/directory/events/${eventId}/kitchen-plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${DIRECTORY_KEY}` },
      body: JSON.stringify({ id, editedAt: new Date().toISOString(), by: { name: "ZZ TEST Noi", role: "Manager" }, changes }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await check("the till's own kitchen-plan edit keeps a paid line it lowers or removes, as the Save does, says so, writes the rest, and a replay answers the same", async () => {
    const id = await settledParty("till door");
    const reads = billingReads.length;
    const editId = randomUUID();
    const changes = [{ op: "set", lineId: "k1", qty: 1 }, { op: "remove", lineId: "b1" }, { op: "set", lineId: "k3", qty: 4 }, { op: "set", lineId: "b2", qty: 1 }];
    const res = await tillEdit(id, changes, editId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(billingReads.length > reads, "the till was asked which lines are paid");
    assert.deepEqual(res.body.paidLinesKept, [
      { id: "k1", itemName: "ZZ TEST paid pizza", list: "kids", paidQuantity: 2 },
      { id: "b1", itemName: "ZZ TEST paid cola", list: "bar", paidQuantity: 2 },
    ]);
    assert.equal(res.body.replayed, false);
    const stored = await storedOf(id);
    assert.deepEqual(counts(stored.kids), [["k1", 2], ["k2", 2], ["k3", 4], ["k4", 1], ["s1", 10]], "the paid pizza as stored; the juice raised as asked");
    assert.deepEqual(counts(stored.bar), [["b1", 2], ["b2", 1]], "the paid cola back where it stood; the unpaid tea lowered");
    const [activity] = await q<{ summary_text: string }>("select summary_text from activity_log where activity_type = 'beo_kitchen_plan_till_edit' and metadata_json like $1", [`%"tillEditId":"${editId}"%`]);
    assert.match(activity!.summary_text, /Kept as billed: ZZ TEST paid pizza \(2 paid\), ZZ TEST paid cola \(2 paid\)\./, "the BEO's activity says what was kept");
    const again = await tillEdit(id, changes, editId);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.paidLinesKept, res.body.paidLinesKept, "the replay answers what the edit did");
    // A raise from the till goes through.
    const raised = await tillEdit(id, [{ op: "set", lineId: "k1", qty: 3 }]);
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.equal(raised.body.paidLinesKept, undefined);
    assert.deepEqual(counts((await storedOf(id)).kids).slice(0, 1), [["k1", 3]]);
  });

  await check("the AI fill's approval keeps a paid line its review lowers, writes the rest of the approval, and says which", async () => {
    const id = await settledParty("ai approve");
    const approve = async () =>
      call("POST", `/api/events/${id}/beo/ai-fill/approve`, {
        expectedState: (await beoReviewState(appDb, id)).version,
        conversationId: null, messageId: null, package: null, setMenu: null,
        menuLines: [
          { menu: "kids", itemName: "ZZ TEST paid pizza", quantity: 1, productCode: null, notes: null, price: 100 },
          { menu: "kids", itemName: "ZZ TEST new nachos", quantity: 2, productCode: null, notes: null, price: 90 },
          { menu: "bar", itemName: "ZZ TEST paid cola", quantity: 1, productCode: null, notes: null, price: 100 },
          { menu: "bar", itemName: "ZZ TEST open-bill tea", quantity: 1, productCode: null, notes: null, price: 100 },
        ],
        entertainment: [], otherLines: [], event: {}, details: { specialRequests: "ZZ TEST 1002 approved with the rest" }, cake: null, deposit: null, sources: [],
      });
    const before = await storedOf(id);
    const res = await approve();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.paidLinesKept, [
      { id: "k1", itemName: "ZZ TEST paid pizza", list: "kids", paidQuantity: 2 },
      { id: "b1", itemName: "ZZ TEST paid cola", list: "bar", paidQuantity: 2 },
    ]);
    const stored = await storedOf(id);
    assert.deepEqual(stored.kids.find((l) => l.id === "k1"), before.kids.find((l) => l.id === "k1"), "the paid pizza exactly as stored");
    assert.equal(stored.kids.find((l) => l.itemName === "ZZ TEST new nachos")?.quantity, 2, "the review's new dish written");
    assert.deepEqual(stored.bar.find((l) => l.id === "b1"), before.bar.find((l) => l.id === "b1"), "the paid cola exactly as stored");
    assert.equal(stored.bar.find((l) => l.id === "b2")?.quantity, 1, "the unpaid tea lowered as reviewed");
    const read = await call("GET", `/api/events/${id}/beo`);
    assert.equal(read.body.specialRequests, "ZZ TEST 1002 approved with the rest", "the rest of the approval written");
  });

  await check("the till not answering: the Save is written as sent, as before the rule", async () => {
    const id = await settledParty("till down");
    tillDown = true;
    try {
      const res = await save(id, { kids: [{ ...k1, quantity: 1 }], adults: [a1], adultsDiffer: true });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.paidLinesKept, undefined);
      assert.deepEqual(counts((await storedOf(id)).kids), [["k1", 1]]);
    } finally {
      tillDown = false;
    }
  });

  console.log(`beo-paid-lines.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
  await appDbPool.end();
}
process.exit(checks === 10 ? 0 : 1);
