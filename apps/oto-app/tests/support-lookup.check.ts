// seed: its own — two park groups of ZZ TEST rows, made here (the slug-`default`
// park group only when the database has none). Not a Playwright file (the suite
// collects *.spec.ts and *.test.ts; this is neither): it boots the app's real
// routes and needs a database with the otoapp schema migrated.
//
// SCRUM-674 — the OTO App's own reader behind the platform Console's support
// lookup, over HTTP against the routes as registered:
//
//   1. Positive: a manager with every park reads the people, events, event and
//      camp registrations and check-ins one phone finds, however the phone was
//      typed and stored, and an operator-wide answer never leaves the park group.
//   2. Empty: a phone nobody here has answers no records. A phone that cannot be
//      one is the 400.
//   3. Denied: no session is the 401, a staff session the 403, and an admin the
//      app cannot place in a park group the 403.
//   4. Foreign scope: a manager of park X reads park X alone: never park Y's
//      records, never somebody with no park, never an advisor; another park
//      group's manager reads only their own, with the same phone.
//   5. Field masking: no answer carries the phone, an email, a photo, a
//      signature, a health or food note, a staff note or pay.
//   6. Bounded: each kind is its newest twenty, saying so.
//   7. Reads only: not one row changes across the reads.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/support-lookup.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("support-lookup.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
/** One number per run, so a rerun on the same database finds only its own rows. */
const local = `08${String(10000000 + Math.floor(Math.random() * 89999999))}`;
const E164 = `+66${local.slice(1)}`;
const DASHED = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
const SPACED = `+66 ${local.slice(1, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
const NOBODY = `+6699${String(1000000 + Math.floor(Math.random() * 8999999))}`;

// ─── Two park groups: X and Y in one, Z in the other ─────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
const otherTenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3), ($4, $5, $6)", [
  tenant, `ZZ TEST slu ${run}`, `zz-slu-${run}`, otherTenant, `ZZ TEST slu other ${run}`, `zz-slu-other-${run}`,
]);
const x = randomUUID();
const y = randomUUID();
const z = randomUUID();
for (const [id, t, label] of [[x, tenant, "x"], [y, tenant, "y"], [z, otherTenant, "z"]] as const) {
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [id, t, `ZZ TEST park ${label} ${run}`]);
}

async function user(role: string, label: string, t: string, branch: string | null): Promise<string> {
  const email = `zz-slu-${label}-${run}@example.com`;
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role} ${label} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    t, id, branch, branch ? "selected_branches" : "all_branches",
  ]);
  return email;
}

const managerAll = await user("manager", "manager-all", tenant, null);
const managerX = await user("manager", "manager-x", tenant, x);
const staffX = await user("staff", "staff-x", tenant, x);
const managerZ = await user("manager", "manager-z", otherTenant, z);
// An admin with access rows in two park groups: the app cannot place them.
const unplaced = await user("admin", "unplaced", tenant, null);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) select $1, id, $2, 'selected_branches' from users where email = $3", [
  otherTenant, z, unplaced,
]);

async function employee(t: string, branch: string | null, label: string, phone: { e164?: string; raw?: string }) {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, start_date, phone, phone_e164)
     values ($1, $2, $3, $4, 'ZZ', $5, 'active', '2020-01-01', $6, $7)`,
    [id, t, branch, `ZZ TEST ${run} ${label}`, `zz-slu-${label}-${id.slice(0, 8)}@example.com`, phone.raw ?? null, phone.e164 ?? null],
  );
  return id;
}
const empX = await employee(tenant, x, "emp-x", { e164: E164 });
const empXRaw = await employee(tenant, x, "emp-x-raw", { raw: DASHED });
const empY = await employee(tenant, y, "emp-y", { e164: E164 });
const empNone = await employee(tenant, null, "emp-none", { e164: E164 });
const empZ = await employee(otherTenant, z, "emp-z", { e164: E164 });
const advisor = randomUUID();
await q(
  `insert into people (id, tenant_id, full_name, email, person_type, phone_number, phone_e164)
   values ($1, $2, $3, $4, 'ADVISOR', $5, $6)`,
  [advisor, tenant, `ZZ TEST ${run} advisor`, `zz-slu-advisor-${run}@example.com`, SPACED, E164],
);

async function event(t: string, branch: string, label: string, date = "2031-02-01", archived = false) {
  const id = randomUUID();
  await q(
    `insert into core_events (id, tenant_id, branch_id, title, event_date, start_time, parent_name, whatsapp_phone_raw, whatsapp_phone_e164, allergies_notes, internal_staff_notes, is_archived)
     values ($1, $2, $3, $4, $5, '10:00', $6, $7, $8, 'ZZ ALLERGY peanut', 'ZZ STAFF NOTE', $9)`,
    [id, t, branch, `ZZ TEST ${run} ${label}`, date, `ZZ PARENT ${label}`, DASHED, E164, archived],
  );
  return id;
}
const eventX = await event(tenant, x, "event-x");
const eventY = await event(tenant, y, "event-y");
const eventZ = await event(otherTenant, z, "event-z");
const eventArchived = await event(tenant, x, "event-archived", "2031-02-02", true);
// An event at X with nobody's phone on it, for the registrations below.
const camp = randomUUID();
await q(
  `insert into core_events (id, tenant_id, branch_id, event_type, title, event_date, start_time) values ($1, $2, $3, 'camp', $4, '2031-03-01', '09:00')`,
  [camp, tenant, x, `ZZ TEST ${run} camp`],
);
const attendee = randomUUID();
await q(
  `insert into event_attendees (id, tenant_id, event_id, child_full_name, parent_name, parent_phone, allergies)
   values ($1, $2, $3, $4, 'ZZ PARENT attendee', $5, 'ZZ ALLERGY peanut')`,
  [attendee, tenant, camp, `ZZ TEST ${run} attendee child`, SPACED],
);
await q(`insert into event_attendee_checkins (tenant_id, event_id, attendee_id, attendance_date, status, checked_in_at) values ($1, $2, $3, '2031-03-01', 'checked_in', '2031-03-01T02:00:00Z')`, [tenant, camp, attendee]);
const camper = randomUUID();
await q(
  `insert into camp_registrations (id, tenant_id, event_id, child_full_name, date_of_birth, parent_guardian_name, emergency_contact_number, parent_contacts, parent_signature, signature_date, allergies)
   values ($1, $2, $3, $4, '2020-01-01', 'ZZ PARENT camper', '0000000000', $5, 'ZZ SIGNATURE', '2031-02-20', 'ZZ ALLERGY peanut')`,
  [camper, tenant, camp, `ZZ TEST ${run} camper`, JSON.stringify([{ name: "ZZ PARENT camper", phone: DASHED }])],
);
await q(`insert into camp_attendance (camp_registration_id, tenant_id, event_id, attendance_date, status, checked_in_at) values ($1, $2, $3, '2031-03-01', 'checked_in', '2031-03-01T02:30:00Z')`, [camper, tenant, camp]);

async function service(t: string, branch: string, label: string, phone: { raw: string; e164: string | null }) {
  const id = randomUUID();
  await q(
    `insert into service_checkins (id, tenant_id, branch_id, parent_full_name, whatsapp_phone_raw, whatsapp_phone_e164, child_full_name, allergies_medical_details, staff_notes, photo_url, consent_signature)
     values ($1, $2, $3, 'ZZ PARENT service', $4, $5, $6, 'ZZ ALLERGY peanut', 'ZZ STAFF NOTE', 'https://zz.test/photo.jpg', 'ZZ SIGNATURE')`,
    [id, t, branch, phone.raw, phone.e164, `ZZ TEST ${run} ${label}`],
  );
  return id;
}
const serviceX = await service(tenant, x, "service-x", { raw: DASHED, e164: E164 });
const serviceY = await service(tenant, y, "service-y", { raw: E164, e164: null });
const serviceZ = await service(otherTenant, z, "service-z", { raw: DASHED, e164: E164 });
const dropoff = randomUUID();
await q(
  `insert into dropoff_checkins (id, tenant_id, branch_id, parent_full_name, whatsapp_phone, whatsapp_phone_e164, children, photo_url, allergies_medical_details)
   values ($1, $2, $3, 'ZZ PARENT dropoff', $4, $5, $6, 'https://zz.test/photo.jpg', 'ZZ ALLERGY peanut')`,
  [dropoff, tenant, x, DASHED, E164, JSON.stringify([{ name: "ZZ child", age: "5" }, { name: "ZZ child 2", age: "6" }])],
);

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
const HARNESS_ENV = {
  NODE_ENV: "test", APP_ENV: "dev", STORAGE_ENV_PREFIX: "zz-test", OBJECT_STORAGE: "local", OTOAPP_LEGACY_LOGIN: "true",
  LOG_LEVEL: "warn", TZ: "UTC", DEPLOY_ENV: "local", OTOAPP_JOBS: "platform", USE_AWS_REKOGNITION: "false",
};

async function serve(): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 120_000);
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

let ORIGIN = "";
async function signIn(email: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

interface Answer {
  status: number;
  body: { records?: Array<Record<string, unknown>>; limit?: number; truncated?: boolean; message?: string; reason?: string } & Record<string, unknown>;
  raw: string;
}
async function byPhone(phone: string, cookie?: string): Promise<Answer> {
  const res = await fetch(`${ORIGIN}/api/support/by-phone?phone=${encodeURIComponent(phone)}`, { headers: cookie ? { cookie } : {} });
  const raw = await res.text();
  let body: Answer["body"] = {};
  try {
    body = JSON.parse(raw) as Answer["body"];
  } catch {
    // Not JSON: kept as raw for the message.
  }
  return { status: res.status, body, raw };
}

const ids = (a: Answer, record: string) => (a.body.records ?? []).filter((r) => r.record === record).map((r) => r.id as string);
const sameSet = (actual: string[], expected: string[], label: string) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const counts = async () => {
  const out: Record<string, number> = {};
  for (const table of ["employees", "people", "core_events", "event_attendees", "event_attendee_checkins", "camp_registrations", "camp_attendance", "service_checkins", "dropoff_checkins", "users"]) {
    out[table] = (await q<{ n: number }>(`select count(*)::int as n from ${table}`))[0]!.n;
  }
  return out;
};

try {
  ORIGIN = await serve();
  const cookies = {
    all: await signIn(managerAll),
    x: await signIn(managerX),
    staff: await signIn(staffX),
    z: await signIn(managerZ),
    unplaced: await signIn(unplaced),
  };
  const before = await counts();

  await check("positive: every park of the group, every kind of record, however the phone was stored", async () => {
    const a = await byPhone(E164, cookies.all);
    assert.equal(a.status, 200, a.raw);
    sameSet(ids(a, "person"), [empX, empXRaw, empY, empNone, advisor], "people");
    sameSet(ids(a, "event"), [eventX, eventY], "events, the archived one left out");
    assert.ok(!ids(a, "event").includes(eventArchived));
    sameSet(ids(a, "event_registration"), [attendee, camper], "registrations");
    const checkins = (a.body.records ?? []).filter((r) => r.record === "checkin");
    const kinds = checkins.map((r) => r.checkinKind as string).sort();
    assert.deepEqual(kinds, ["camp", "dropoff", "event", "service", "service"]);
    const drop = checkins.find((r) => r.checkinKind === "dropoff")!;
    assert.equal(drop.children, 2);
    assert.equal(drop.id, dropoff);
    assert.ok(checkins.some((r) => r.id === serviceX) && checkins.some((r) => r.id === serviceY));
    const parkOfX = (a.body.records ?? []).find((r) => r.id === eventX)!;
    assert.equal(parkOfX.park, `ZZ TEST park x ${run}`);
    assert.equal(parkOfX.branchId, x);
    assert.equal(a.body.truncated, false);
  });

  await check("positive: the phone is found however it is typed", async () => {
    const canonical = await byPhone(E164, cookies.all);
    for (const typed of [DASHED, SPACED, local]) {
      const a = await byPhone(typed, cookies.all);
      assert.equal(a.status, 200, a.raw);
      assert.equal((a.body.records ?? []).length, (canonical.body.records ?? []).length, typed);
    }
  });

  await check("empty: a phone nobody here has; a phone that cannot be one is the 400", async () => {
    const a = await byPhone(NOBODY, cookies.all);
    assert.equal(a.status, 200, a.raw);
    assert.deepEqual(a.body.records, []);
    assert.equal((await byPhone("not a phone", cookies.all)).status, 400);
    const missing = await fetch(`${ORIGIN}/api/support/by-phone`, { headers: { cookie: cookies.all } });
    assert.equal(missing.status, 400);
  });

  await check("denied: no session, a staff session, an admin the app cannot place", async () => {
    assert.equal((await byPhone(E164)).status, 401);
    const staff = await byPhone(E164, cookies.staff);
    assert.equal(staff.status, 403, staff.raw);
    assert.equal(staff.body.records, undefined);
    const lost = await byPhone(E164, cookies.unplaced);
    assert.equal(lost.status, 403, lost.raw);
    assert.equal(lost.body.reason, "no_park_group");
  });

  await check("foreign scope: a manager of park X reads park X alone", async () => {
    const a = await byPhone(E164, cookies.x);
    assert.equal(a.status, 200, a.raw);
    sameSet(ids(a, "person"), [empX, empXRaw], "never park Y, nobody with no park, no advisor");
    sameSet(ids(a, "event"), [eventX], "events");
    sameSet(ids(a, "event_registration"), [attendee, camper], "registrations at X");
    const service = (a.body.records ?? []).filter((r) => r.checkinKind === "service").map((r) => r.id as string);
    sameSet(service, [serviceX], "check-ins");
    for (const hidden of [empY, empNone, advisor, eventY, serviceY]) assert.ok(!a.raw.includes(hidden), hidden);
    assert.ok(!a.raw.includes(`ZZ TEST park y ${run}`));
  });

  await check("foreign scope: another park group reads only its own, with the same phone", async () => {
    const a = await byPhone(E164, cookies.z);
    assert.equal(a.status, 200, a.raw);
    sameSet(ids(a, "person"), [empZ], "people");
    sameSet(ids(a, "event"), [eventZ], "events");
    sameSet(ids(a, "checkin"), [serviceZ], "check-ins");
    for (const hidden of [empX, empY, eventX, eventY, serviceX, dropoff]) assert.ok(!a.raw.includes(hidden), hidden);
    const b = await byPhone(E164, cookies.all);
    for (const hidden of [empZ, eventZ, serviceZ]) assert.ok(!b.raw.includes(hidden), hidden);
  });

  await check("field masking: no phone, email, photo, signature, note or pay in any answer", async () => {
    const a = await byPhone(E164, cookies.all);
    const raw = a.raw;
    for (const forbidden of [E164, E164.slice(1), DASHED, SPACED, local, "@example.com", "zz.test", "ZZ SIGNATURE", "ZZ ALLERGY", "ZZ STAFF NOTE", "photo"]) {
      assert.ok(!raw.includes(forbidden), `the answer carries ${forbidden}`);
    }
    const keys = new Set((a.body.records ?? []).flatMap((r) => Object.keys(r)));
    for (const key of ["phone", "phoneE164", "email", "allergies", "staffNotes", "photoUrl", "salary", "address"]) assert.ok(!keys.has(key), key);
    // A person's name is under the keys the Console's mask covers, and nowhere else.
    for (const record of a.body.records ?? []) {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string" && value.startsWith("ZZ PARENT")) assert.equal(key, "guardianName");
        if (typeof value === "string" && value.startsWith(`ZZ TEST ${run}`)) assert.equal(key, "name");
      }
    }
  });

  await check("bounded: each kind is its newest twenty, saying so", async () => {
    for (let i = 0; i < 22; i += 1) {
      await event(tenant, y, `bounded-${i}`, `2032-01-${String(i + 1).padStart(2, "0")}`);
    }
    const a = await byPhone(E164, cookies.all);
    assert.equal(a.status, 200, a.raw);
    assert.equal(a.body.limit, 20);
    assert.equal(a.body.truncated, true);
    const events = (a.body.records ?? []).filter((r) => r.record === "event");
    assert.equal(events.length, 20);
    assert.equal(events[0]!.date, "2032-01-22");
  });

  await check("reads only: a read-only transaction, and the route changes no row", async () => {
    const after = await counts();
    assert.equal(after.core_events, before.core_events + 22, "only the fixture's own events were added");
    assert.deepEqual({ ...after, core_events: 0 }, { ...before, core_events: 0 });
    const source = readFileSync(join(APP_DIR, "server", "support-lookup-routes.ts"), "utf8");
    assert.ok(source.includes('accessMode: "read only"'));
    assert.ok(!/\.(insert|update|delete)\(/.test(source));
  });

  console.log(`support-lookup.check: ${checks} checks passed`);
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
process.exit(0);
