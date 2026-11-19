// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file. Boots the app's real routes (tests/harness/serve-routes.ts) and a
// stand-in platform, and needs a database whose otoapp schema the app's
// migrator has built.
//
// SCRUM-1032, SCRUM-1033 — through the app's real routes, on app migration 0055:
//
//   - an activity of before (one person by its assignment target) reads with
//     that person, kept; an activity with none reads with nobody;
//   - an activity's people written: staff by name, one or several (one who has
//     left stays named), a role with its number, the person of before kept or
//     taken off (its target row left alone); each a target the activity owns,
//     in its order; a person of another park group, or a body the activity
//     cannot store, refused in words with nothing written; the database's own
//     check refuses a role's number of 0; an activity removed takes its own
//     targets with it;
//   - the one timeline's step for the activity carries all its people, and the
//     Staff BEO prints them with the activity's note;
//   - a dish's and a drink's own serving time and group stored by the BEO's
//     Save as sent, the timeline's food step at that time; a Save with a time
//     that is no time of day refused in words, nothing written;
//   - nothing of either reaches the platform.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/beo-activity-people-db.check.ts
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
  console.error("beo-activity-people-db.check: DATABASE_URL is not set");
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
        party: { title: "ZZ TEST 1032", date: "2099-03-14", startTime: null, endTime: null, packageName: null, kids: 10, adults: 4 },
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
const otherTenant = randomUUID();
const branch = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3), ($4, $5, $6)", [tenant, `ZZ TEST 1032 ${run}`, `zz-1032-${run}`, otherTenant, `ZZ TEST 1032 other ${run}`, `zz-1032-o-${run}`]);
await q("insert into branches (id, tenant_id, name, address, core_branch_id) values ($1, $2, $3, 'ZZ TEST', $4)", [branch, tenant, `ZZ TEST 1032 park ${run}`, randomUUID()]);
const adminId = randomUUID();
const adminEmail = `zz-1032-admin-${run}@example.com`;
const salt = randomBytes(16).toString("hex");
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_verified)
   values ($1, $2, $3, 'ZZ TEST admin', 'admin', true, false, true)`,
  [adminId, adminEmail, `${scryptSync(PASSWORD, salt, 64).toString("hex")}.${salt}`],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, adminId]);
/** A member of the staff list. */
async function staff(nickname: string, state: "ACTIVE" | "LEFT" = "ACTIVE", ownTenant = tenant) {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, employment_state)
     values ($1, $2, $3, $4, $5, $6, 'active', $7)`,
    [id, ownTenant, ownTenant === tenant ? branch : null, `ZZ TEST ${nickname} full ${run}`, `ZZ ${nickname}`, `zz-1032-${nickname.toLowerCase()}-${run}@example.com`, state],
  );
  return id;
}
const nok = await staff("Nok");
const ploy = await staff("Ploy");
const left = await staff("Left", "LEFT");
const stranger = await staff("Stranger", "ACTIVE", otherTenant);
const animator = randomUUID();
await q("insert into roles (id, tenant_id, name) values ($1, $2, $3)", [animator, tenant, `ZZ TEST Animator ${run}`]);

async function party(title: string) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time, num_children, num_adults, status)
     values ($1, $2, $3, 'birthday', $4, '2099-03-14', '11:00', '14:00', 10, 4, 'upcoming')`,
    [id, tenant, branch, `ZZ TEST BEO 1032 ${title} ${run}`],
  );
  return id;
}
/** An activity as one was stored before: its one person by an assignment target (a role, as the old kinds hold). */
async function olderActivity(eventId: string) {
  const target = randomUUID();
  await q("insert into beo_assignment_targets (id, tenant_id, target_type, role_id) values ($1, $2, 'ROLE', $3)", [target, tenant, animator]);
  const id = randomUUID();
  await q(
    "insert into beo_entertainment_items (id, event_id, tenant_id, custom_name, start_time, assignment_target_id, sort_order) values ($1, $2, $3, 'ZZ TEST Bubble show', '12:00', $4, 0)",
    [id, eventId, tenant, target],
  );
  return { id, target };
}
type Target = { target_type: string; employee_id: string | null; role_id: string | null; head_count: number | null; sort_order: number };
const ownedOf = (itemId: string) =>
  q<Target>("select target_type::text, employee_id, role_id, head_count, sort_order from beo_assignment_targets where entertainment_item_id = $1 order by sort_order", [itemId]);

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
      OTOAPP_PROVISION_KEY: "zz-1032-key",
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
  const actsOf = async (eventId: string) => (await call("GET", `/api/events/${eventId}/beo/entertainment-items`)).body as Array<{ id: string; notes: string | null; assignmentTargetId: string | null; people: Array<{ type: string; id: string; targetId: string; label: string; count: number | null; kept?: boolean }> }>;
  const setPeople = (eventId: string, itemId: string, people: unknown[]) => call("PUT", `/api/events/${eventId}/beo/entertainment-items/${itemId}/people`, { people });

  await check("an activity of before reads with its one person, kept; an activity with none reads with nobody", async () => {
    const event = await party("older");
    const older = await olderActivity(event);
    const fresh = await call("POST", `/api/events/${event}/beo/entertainment-items`, { customName: "ZZ TEST Treasure hunt", sortOrder: 1 });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    const acts = await actsOf(event);
    assert.deepEqual(acts.map((a) => a.people.map((p) => [p.type, p.id, p.targetId, p.label, p.count, p.kept ?? false])), [
      [["role", animator, older.target, `ZZ TEST Animator ${run}`, null, true]],
      [],
    ]);
  });

  await check("staff by name, one or several (one who has left stays named), a role with its number; the person of before kept, then taken off", async () => {
    const event = await party("people");
    const older = await olderActivity(event);
    const res = await setPeople(event, older.id, [{ type: "kept", id: older.target }, { type: "employee", id: nok }, { type: "employee", id: left }, { type: "role", id: animator, count: 2 }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.people.map((p: { label: string; count: number | null; kept?: boolean }) => [p.label, p.count, p.kept ?? false]), [
      [`ZZ TEST Animator ${run}`, null, true],
      ["ZZ Nok", null, false],
      ["ZZ Left", null, false],
      [`ZZ TEST Animator ${run}`, 2, false],
    ]);
    assert.deepEqual((await ownedOf(older.id)).map((t) => [t.target_type, t.employee_id, t.role_id, t.head_count, t.sort_order]), [
      ["EMPLOYEE", nok, null, null, 0],
      ["EMPLOYEE", left, null, null, 1],
      ["ROLE", null, animator, 2, 2],
    ]);
    assert.equal((await q<{ assignment_target_id: string | null }>("select assignment_target_id from beo_entertainment_items where id = $1", [older.id]))[0]!.assignment_target_id, older.target, "kept as it was");
    // One person only, the person of before taken off: its target row stays (the app's reusable record).
    const one = await setPeople(event, older.id, [{ type: "employee", id: ploy }]);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(one.body.people.map((p: { label: string }) => p.label), ["ZZ Ploy"]);
    assert.deepEqual((await ownedOf(older.id)).map((t) => t.employee_id), [ploy]);
    assert.equal((await q<{ assignment_target_id: string | null }>("select assignment_target_id from beo_entertainment_items where id = $1", [older.id]))[0]!.assignment_target_id, null);
    assert.equal((await q("select 1 from beo_assignment_targets where id = $1", [older.target])).length, 1);
    // Nobody.
    assert.deepEqual((await setPeople(event, older.id, [])).body.people, []);
    assert.deepEqual(await ownedOf(older.id), []);
  });

  await check("a person of another park group, or a body the activity cannot store, is refused in words and nothing is written", async () => {
    const event = await party("refused");
    const older = await olderActivity(event);
    assert.equal((await setPeople(event, older.id, [{ type: "employee", id: nok }])).status, 200);
    for (const [people, words] of [
      [[{ type: "employee", id: stranger }], /not on the park's staff list/],
      [[{ type: "role", id: animator, count: 0 }], /whole number from 1 to 99/],
      [[{ type: "employee", id: nok }, { type: "employee", id: nok }], /named twice/],
      [[{ type: "kept", id: randomUUID() }], /no longer names that person/],
    ] as const) {
      const res = await setPeople(event, older.id, [...people]);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, words);
      assert.deepEqual((await ownedOf(older.id)).map((t) => t.employee_id), [nok], "nothing written");
    }
    // Another party's activity is not this party's.
    const other = await party("other");
    assert.equal((await setPeople(other, older.id, [{ type: "employee", id: ploy }])).status, 404);
    await assert.rejects(q("update beo_assignment_targets set head_count = 0 where entertainment_item_id = $1", [older.id]), /beo_assignment_targets_head_count_check/);
    // An activity removed takes its own targets with it.
    assert.equal((await call("DELETE", `/api/events/${event}/beo/entertainment-items/${older.id}`)).status, 204);
    assert.deepEqual(await ownedOf(older.id), []);
  });

  await check("the timeline's step carries all the activity's people; the Staff BEO prints them with the activity's note", async () => {
    const event = await party("printed");
    const older = await olderActivity(event);
    assert.equal((await setPeople(event, older.id, [{ type: "employee", id: nok }, { type: "employee", id: left }, { type: "role", id: animator, count: 2 }])).status, 200);
    const noted = await call("PUT", `/api/events/${event}/beo/entertainment-items/${older.id}`, { notes: "ZZ TEST bring the bubble machine" });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    const built = await call("GET", `/api/events/${event}/beo/timeline/built`);
    const step = built.body.steps.find((s: { key: string }) => s.key === `entertainment::${older.id}`);
    assert.deepEqual([step.people, step.person], [["ZZ Nok", "ZZ Left", `2 × ZZ TEST Animator ${run}`], `ZZ Nok, ZZ Left, 2 × ZZ TEST Animator ${run}`]);
    const pdf = await fetch(`${origin}/api/events/${event}/beo/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200, await pdf.clone().text());
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.ok((await pdf.arrayBuffer()).byteLength > 1000, "a PDF");
  });

  await check("a dish's and a drink's own serving time and group stored by the Save as sent; the timeline's step at that time; a time of no day refused", async () => {
    const event = await party("serving");
    const save = (kids: unknown[], bar: unknown[]) => call("PUT", `/api/events/${event}/beo`, {
      event: {},
      kitchenPlan: {
        foodRequired: true, cakeMode: "NONE", setMenuEnabled: false, setMenuTemplateId: null, serviceSchedule: [],
        menus: { kids, adults: [], adultsDiffer: false, kidsFoodTime: "11:30", adultsFoodTime: "" },
      },
      barPlan: { serviceTime: "11:30", items: bar },
    });
    const kids = [
      { id: "zz-k1", itemName: "ZZ TEST Pizza", quantity: 3, notes: "", included: true, price: 0, source: "set_menu" },
      { id: "zz-k2", itemName: "ZZ TEST Skewers", quantity: 2, notes: "", included: false, price: 0, source: "additional", serviceTime: "13:00", serviceGroup: "ZZ Dessert" },
    ];
    const bar = [{ id: "zz-b1", itemName: "ZZ TEST Coffee", quantity: 4, notes: "", price: 0, serviceTime: "13:30" }];
    const res = await save(kids, bar);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [plan] = await q<{ menus: { kids: Array<Record<string, unknown>> } }>("select menus from beo_kitchen_plans where event_id = $1", [event]);
    assert.deepEqual(plan!.menus.kids.map((k) => [k.id, k.serviceTime ?? null, k.serviceGroup ?? null]), [["zz-k1", null, null], ["zz-k2", "13:00", "ZZ Dessert"]]);
    const [barRow] = await q<{ items: Array<Record<string, unknown>> }>("select items from beo_bar_plans where event_id = $1", [event]);
    assert.equal(barRow!.items[0]!.serviceTime, "13:30");
    const built = await call("GET", `/api/events/${event}/beo/timeline/built`);
    const food = built.body.steps.filter((s: { kind: string }) => s.kind === "food").map((s: { key: string; time: string; detail: string | null }) => [s.key, s.time, s.detail]);
    assert.deepEqual(food, [["kids_food", "11:30", null], ["bar_service", "11:30", null], ["kids_food::13:00", "13:00", "ZZ Dessert"], ["bar_service::13:30", "13:30", null]]);
    // The generator stored the new steps' rows, under their own keys, for the Day-of view's ticks.
    const rows = await q<{ source_key: string }>("select source_key from beo_timeline_items where event_id = $1 and is_system_generated order by source_key", [event]);
    assert.ok(rows.some((r) => r.source_key === "kids_food::13:00") && rows.some((r) => r.source_key === "bar_service::13:30"), JSON.stringify(rows));
    // A time of no day: refused in words; nothing written.
    const refused = await save([{ ...kids[1], serviceTime: "25:00" }], bar);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "ZZ TEST Skewers: its serving time must be a time of day (HH:MM), or empty.");
    const [after] = await q<{ menus: { kids: Array<Record<string, unknown>> } }>("select menus from beo_kitchen_plans where event_id = $1", [event]);
    assert.deepEqual(after!.menus.kids, plan!.menus.kids, "nothing of the refused Save written");
  });

  await check("nothing of either reaches the platform", async () => {
    assert.ok(platformAsked.length > 0, "the app asked the platform (the till's billing read)");
    for (const asked of platformAsked) {
      assert.equal(/serviceTime|serviceGroup|ZZ Dessert|head_?count|headCount|entertainment|Animator|ZZ Nok|bubble/i.test(asked), false, asked.slice(0, 200));
    }
  });

  console.log(`beo-activity-people-db.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
process.exit(checks === 6 ? 0 : 1);
