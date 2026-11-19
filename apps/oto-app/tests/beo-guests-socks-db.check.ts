// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) and a
// stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built.
//
// SCRUM-1030, SCRUM-1031 — the BEO's new fields through its real routes:
//
//   - a party saved before them (its row made with the old columns only) opens
//     with all four empty, and a Save that names none of them leaves them
//     empty and the rest of the party as it was;
//   - the BEO's Save stores the expected extra guests and the socks
//     arrangement (and the note of "Other / Custom"), the read answers them,
//     and a Save may empty them again;
//   - a Save naming something the party cannot store is refused in words and
//     writes nothing, not even its other fields; the database's own checks
//     refuse it too;
//   - the Kitchen Notes typed on the Day-of view (PUT …/beo/kitchen-plan) stay
//     when the BEO's Save does not name them; a Save naming them writes them;
//   - nothing of either reaches the platform: no request the app sends it
//     carries them.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/beo-guests-socks-db.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("beo-guests-socks-db.check: DATABASE_URL is not set");
  process.exit(2);
}

let checks = 0;
const check = async (title: string, fn: () => Promise<void> | void) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${title}`);
};

// ─── The stand-in platform: what the app asks of it is recorded ──────────────

const platformAsked: string[] = [];
const platform = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    platformAsked.push(`${req.method} ${req.url} ${raw}`);
    const read = /^\/otoapp\/parties\/([^/]+)\/billing$/.exec(req.url ?? "");
    if (req.method === "GET" && read) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        additionalBills: [], eventId: read[1], state: "none",
        park: { name: "ZZ TEST", branchName: "ZZ TEST park", address: null },
        party: { title: "ZZ TEST 1031", date: "2099-03-14", startTime: null, endTime: null, packageName: null, kids: 10, adults: 4 },
        quote: null, sale: null, noQuote: null, beoLines: [],
      }));
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
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST 1031 ${run}`, `zz-1031-${run}`]);
await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)", [branch, tenant, `ZZ TEST 1031 park ${run}`, randomUUID()]);
const adminId = randomUUID();
const adminEmail = `zz-1031-admin-${run}@example.com`;
const salt = randomBytes(16).toString("hex");
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
   values ($1, $2, $3, 'ZZ TEST admin', 'admin', true, false, true)`,
  [adminId, adminEmail, `${scryptSync(PASSWORD, salt, 64).toString("hex")}.${salt}`],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, adminId]);
/** A party made as one was before the new columns: its old fields only. */
async function party(title: string) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status, special_requests)
     values ($1, $2, $3, 'birthday', $4, '2099-03-14', '13:00', '16:00', 10, 4, 'upcoming', 'ZZ TEST a quiet corner')`,
    [id, tenant, branch, `ZZ TEST BEO 1031 ${title} ${run}`],
  );
  return id;
}
type Row = { title: string; special_requests: string | null; num_children: number | null; expected_extra_kids: number | null; expected_extra_adults: number | null; socks_arrangement: string | null; socks_note: string | null };
const rowOf = async (id: string) =>
  (await q<Row>("select title, special_requests, num_children, expected_extra_kids, expected_extra_adults, socks_arrangement, socks_note from core_events where id = $1", [id]))[0]!;
const fourOf = (r: Row) => [r.expected_extra_kids, r.expected_extra_adults, r.socks_arrangement, r.socks_note];

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
      OTOAPP_PROVISION_KEY: "zz-1031-key",
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
  /** The editor's Save, with the event fields given and a kitchen plan. */
  const save = (eventId: string, event: Record<string, unknown>, kitchen: Record<string, unknown> = {}) =>
    call("PUT", `/api/events/${eventId}/beo`, {
      event,
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null,
        menus: { kids: [], adults: [], adultsDiffer: false, kidsFoodTime: "", adultsFoodTime: "" },
        serviceSchedule: [],
        ...kitchen,
      },
    });

  await check("a party saved before the new fields opens with them empty; a Save that names none leaves them empty and the rest as it was", async () => {
    const id = await party("older");
    const read = await call("GET", `/api/events/${id}/beo`);
    assert.equal(read.status, 200);
    assert.deepEqual([read.body.expectedExtraKids, read.body.expectedExtraAdults, read.body.socksArrangement, read.body.socksNote], [null, null, null, null]);
    const before = await rowOf(id);
    const res = await save(id, { title: before.title, numChildren: 10, specialRequests: "ZZ TEST a quiet corner" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await rowOf(id);
    assert.deepEqual(fourOf(after), [null, null, null, null]);
    assert.deepEqual([after.title, after.special_requests, after.num_children], [before.title, before.special_requests, before.num_children]);
  });

  await check("the Save stores the expected extra guests and the socks arrangement; the read answers them; a Save may empty them", async () => {
    const id = await party("stored");
    const res = await save(id, { expectedExtraKids: 1, expectedExtraAdults: 6, socksArrangement: "other", socksNote: "ZZ TEST ถุงเท้า paid by grandma" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(fourOf(await rowOf(id)), [1, 6, "other", "ZZ TEST ถุงเท้า paid by grandma"]);
    const read = await call("GET", `/api/events/${id}/beo`);
    assert.deepEqual([read.body.expectedExtraKids, read.body.expectedExtraAdults, read.body.socksArrangement, read.body.socksNote], [1, 6, "other", "ZZ TEST ถุงเท้า paid by grandma"]);
    // A Save that names none of them keeps them.
    assert.equal((await save(id, { title: (await rowOf(id)).title })).status, 200);
    assert.deepEqual(fourOf(await rowOf(id)), [1, 6, "other", "ZZ TEST ถุงเท้า paid by grandma"]);
    // Emptied.
    assert.equal((await save(id, { expectedExtraKids: null, expectedExtraAdults: 0, socksArrangement: null, socksNote: null })).status, 200);
    assert.deepEqual(fourOf(await rowOf(id)), [null, 0, null, null]);
  });

  await check("a Save naming what the party cannot store is refused in words and writes nothing; the database refuses it too", async () => {
    const id = await party("refused");
    const before = await rowOf(id);
    for (const [event, words] of [
      [{ title: "ZZ TEST must not be written", socksArrangement: "pay_at_reception" }, /^The socks arrangement must be one of: Birthday Parent Pays, Guests Pay Individually, Other \/ Custom; or not set\.$/],
      [{ title: "ZZ TEST must not be written", expectedExtraKids: -1 }, /^The expected extra children must be a whole number from 0 to 999, or empty\.$/],
      [{ title: "ZZ TEST must not be written", expectedExtraAdults: 2.5 }, /expected extra adults/],
      [{ title: "ZZ TEST must not be written", socksNote: "x".repeat(201) }, /at most 200 characters/],
    ] as const) {
      const res = await save(id, event, { kitchenNotes: "ZZ TEST must not be written" });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, words);
      assert.deepEqual(await rowOf(id), before, "nothing of the Save written");
      assert.equal((await q("select count(*)::int as n from beo_kitchen_plans where event_id = $1", [id]))[0]!.n, 0, "no kitchen plan written");
    }
    await assert.rejects(q("update core_events set socks_arrangement = 'pay_at_reception' where id = $1", [id]), /core_events_socks_arrangement_check/);
    await assert.rejects(q("update core_events set expected_extra_adults = -1 where id = $1", [id]), /core_events_expected_extra_check/);
  });

  await check("SCRUM-1030: the Kitchen Notes typed on the Day-of view stay when the BEO's Save does not name them; a Save naming them writes them", async () => {
    const id = await party("kitchen notes");
    assert.equal((await save(id, {})).status, 200);
    const dayOf = await call("PUT", `/api/events/${id}/beo/kitchen-plan`, { kitchenNotes: "ZZ TEST prepare the kids' food first" });
    assert.equal(dayOf.status, 200, JSON.stringify(dayOf.body));
    const notes = async () => (await q<{ kitchen_notes: string | null }>("select kitchen_notes from beo_kitchen_plans where event_id = $1", [id]))[0]!.kitchen_notes;
    assert.equal(await notes(), "ZZ TEST prepare the kids' food first");
    assert.equal((await save(id, { title: (await rowOf(id)).title })).status, 200);
    assert.equal(await notes(), "ZZ TEST prepare the kids' food first", "not named: kept");
    assert.equal((await save(id, {}, { kitchenNotes: "ZZ TEST parents order more on arrival" })).status, 200);
    assert.equal(await notes(), "ZZ TEST parents order more on arrival");
    assert.equal((await call("GET", `/api/events/${id}/beo`)).body.kitchenPlan.kitchenNotes, "ZZ TEST parents order more on arrival");
    assert.equal((await save(id, {}, { kitchenNotes: "  " })).status, 200);
    assert.equal(await notes(), null, "emptied");
  });

  await check("the Staff BEO route prints a party with the new fields and one without; nothing of them reaches the platform", async () => {
    // The print asks the till for the party's money (readingFor): the one request it sends.
    const stored = await party("printed");
    assert.equal((await save(stored, { expectedExtraKids: 1, expectedExtraAdults: 6, socksArrangement: "guests" }, { kitchenNotes: "ZZ TEST kitchen words" })).status, 200);
    for (const id of [stored, await party("printed older")]) {
      const res = await fetch(`${origin}/api/events/${id}/beo/pdf`, { headers: { cookie } });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(res.headers.get("content-type"), "application/pdf");
      assert.ok((await res.arrayBuffer()).byteLength > 1000, "a PDF");
    }
    assert.ok(platformAsked.length > 0, "the app asked the platform (the till's billing read)");
    for (const asked of platformAsked) {
      assert.equal(/expected_?extra|socks_?(arrangement|note)|expectedExtra|socksArrangement|socksNote|grandma|kitchen ?notes/i.test(asked), false, asked.slice(0, 200));
    }
  });

  console.log(`beo-guests-socks-db.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
process.exit(checks === 5 ? 0 : 1);
