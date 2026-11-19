// seed: its own — ZZ TEST park groups, people and leave made here. Not a
// Playwright file (the suite collects *.spec.ts and *.test.ts; this is
// neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated.
//
// SCRUM-1037 — who a leave type is for (the owner's answer of 19 November
// 2026: Training and Other off; staff see annual leave and holidays; the
// other legal types for managers only), over HTTP on the routes as registered
// and in the database migration 0053 made:
//
//   1. The rule itself (server/lib/leaveTypeAudience.ts): a managers-only
//      type is left out for anyone below manager and refused to them in words;
//      a switched-off type is refused to everyone.
//   2. A new park group's catalogue is made with the owner's set.
//   3. The list per role: staff are not shown Sick Leave, Business Days,
//      Unpaid Leave or a park's own managers-only type; a manager and an admin
//      are shown every type; the setting is saved and read on the type.
//   4. Recording: a manager records a managers-only type for a person; staff
//      record nothing (the app's manager rule, as before) and nothing is
//      saved; Training and Other are refused to everyone, new or changed.
//   5. Nothing lost: a person's own Training and Other leave, and every other
//      record, reads as before in their own history and balances.
//   6. Existing park groups: 0053 replayed twice gives the same result; it
//      sets only the built-in codes, leaves a park's own type and a renamed
//      built-in as they were, and writes no time-off row or opening.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built:
//   npx tsx tests/leave-type-audience.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { leaveTypeRefusal, leaveTypesShownTo } from "../server/lib/leaveTypeAudience";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("leave-type-audience.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 6 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const RUN = run.toUpperCase();
/** A Bangkok calendar date `n` days from today. */
const day = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
const thisYear = Number(day(0).slice(0, 4));

const BUILTIN = ["ANNUAL", "BUSINESS", "CHANGE_DAY_OFF", "OTHER", "SICK", "TRAINING", "UNPAID"];
const MANAGERS_ONLY = ["BUSINESS", "SICK", "UNPAID"];
const STAFF_SEE = ["ANNUAL", "CHANGE_DAY_OFF"];
const SWITCHED_OFF = ["OTHER", "TRAINING"];

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");

interface Person { id: string; email: string }
interface ParkGroup { tenant: string; x: string; admin: Person; manager: Person; staff: Person }

async function user(tenant: string, role: string, label: string, branch: string): Promise<Person> {
  const id = randomUUID();
  const email = `zz-lta-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [tenant, id, branch]);
  return { id, email };
}

async function employee(g: ParkGroup, label: string, userId: string | null = null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, start_date, user_id)
     values ($1, $2, $3, $4, 'ZZ', $5, 'active', '2020-01-01', $6)`,
    [id, g.tenant, g.x, `ZZ TEST ${run} ${label}`, `zz-lta-${label}-${id.slice(0, 8)}@example.com`, userId],
  );
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST lta ${label} ${run}`, `zz-lta-${label}-${run}`]);
  const x = randomUUID();
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [x, tenant, `ZZ TEST lta ${label} ${run}`]);
  return {
    tenant,
    x,
    admin: await user(tenant, "admin", `${label}-admin`, x),
    manager: await user(tenant, "manager", `${label}-manager`, x),
    staff: await user(tenant, "staff", `${label}-staff`, x),
  };
}

/** A time-off row written as the app writes one, straight into the table (history made before this change). */
async function pastLeave(g: ParkGroup, employeeId: string, type: string, date: string): Promise<string> {
  const [{ id }] = await q<{ id: string }>(
    `insert into employee_time_off (tenant_id, employee_id, branch_id, type, start_date, end_date, created_by)
     values ($1, $2, $3, $4, $5::timestamp, $5::timestamp, $6) returning id`,
    [g.tenant, employeeId, g.x, type, date, g.admin.id],
  );
  return id;
}

const children: ChildProcess[] = [];
const HARNESS_ENV = {
  NODE_ENV: "test",
  APP_ENV: "dev",
  STORAGE_ENV_PREFIX: "zz-test",
  OBJECT_STORAGE: "local",
  OTOAPP_LEGACY_LOGIN: "true",
  LOG_LEVEL: "warn",
  TZ: "UTC",
  DEPLOY_ENV: "local",
  OTOAPP_JOBS: "platform",
  USE_AWS_REKOGNITION: "false",
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
    const timer = setTimeout(() => reject(new Error(`harness did not start:\n${output}`)), 90_000);
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

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}

let ORIGIN = "";
async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body };
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)}`;

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in as ${email}: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

type TypeRow = { id: string; code: string; name: string; isActive: boolean; managersOnly: boolean };
const codes = (rows: { code: string }[]) => rows.map((r) => r.code).sort();
const byCode = <T extends { code: string }>(rows: T[], code: string) => {
  const row = rows.find((r) => r.code === code);
  assert.ok(row, `no ${code} in ${JSON.stringify(codes(rows))}`);
  return row!;
};

// The migration as the migrator applies it: each statement between breakpoints, in order.
const MIGRATION_0053 = readFileSync(join(APP_DIR, "migrations", "0053_leave_type_managers_only.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);
async function replay0053() {
  const client = await pool.connect();
  try {
    for (const statement of MIGRATION_0053) await client.query(statement);
  } finally {
    client.release();
  }
}

/** Every column of a park group's leave types, in a fixed order. */
const typesRows = (tenant: string) =>
  q("select * from leave_types where tenant_id = $1 order by code", [tenant]);
/** Every column of the park group's time-off rows and openings: the history that must not move. */
const historyRows = async (tenant: string) => ({
  timeOff: await q("select * from employee_time_off where tenant_id = $1 order by id", [tenant]),
  openings: await q("select * from employee_leave_balance_openings where tenant_id = $1 order by id", [tenant]),
});

try {
  // ── 1. The rule itself ──────────────────────────────────────────────────────
  console.log("1. the rule (server/lib/leaveTypeAudience.ts):");
  await check("a managers-only type is left out for anyone below manager and refused to them in words; a switched-off type is refused to everyone", () => {
    const sick = { code: "SICK", name: "Sick Leave", isActive: true, managersOnly: true };
    const annual = { code: "ANNUAL", name: "Annual Leave", isActive: true, managersOnly: false };
    const training = { code: "TRAINING", name: "Training", isActive: false, managersOnly: false };
    assert.deepEqual(codes(leaveTypesShownTo([sick, annual, training], false)), ["ANNUAL", "TRAINING"]);
    assert.deepEqual(codes(leaveTypesShownTo([sick, annual, training], true)), ["ANNUAL", "SICK", "TRAINING"]);
    assert.equal(leaveTypeRefusal(sick, true), null);
    assert.equal(leaveTypeRefusal(annual, false), null);
    assert.deepEqual(leaveTypeRefusal(sick, false), {
      status: 403,
      message: "Sick Leave is for managers only: ask your manager to record it for you",
    });
    for (const manager of [true, false]) {
      assert.deepEqual(leaveTypeRefusal(training, manager), { status: 400, message: "Unknown or inactive leave type" });
      assert.deepEqual(leaveTypeRefusal(undefined, manager), { status: 400, message: "Unknown or inactive leave type" });
    }
  });

  // ── 6 (first half). An existing park group, its catalogue made before 0053 ──
  // Made the way 0018's seed made every catalogue: seven built-in types, each
  // on and seen by everyone. Plus what a park may have done since: its own
  // type, a renamed built-in, and leave already taken on Training and Other.
  const OLD = await parkGroup("old");
  await q(
    `insert into leave_types (tenant_id, code, name, is_active, managers_only, accrual_method, annual_days, days_worked_required, days_off_earned)
     values ($1, 'ANNUAL', 'Annual Leave', true, false, 'YEARLY', 8, 0, 0),
            ($1, 'BUSINESS', 'Business Days', true, false, 'YEARLY', 3, 0, 0),
            ($1, 'SICK', 'Sick Leave', true, false, 'YEARLY', 30, 0, 0),
            ($1, 'CHANGE_DAY_OFF', 'Days Off', true, false, 'WORKDAYS', 0, 5, 2),
            ($1, 'UNPAID', 'Unpaid Leave', true, false, 'NONE', 0, 0, 0),
            ($1, 'TRAINING', 'Training', true, false, 'NONE', 0, 0, 0),
            ($1, 'OTHER', 'ZZ Renamed by the park', true, false, 'NONE', 0, 0, 0),
            ($1, $2, 'ZZ Park own type', true, false, 'NONE', 0, 0, 0)`,
    [OLD.tenant, `ZZ_OWN_${RUN}`],
  );
  // Hired after the catalogue, so the app's lazy start freezes no opening for
  // them; the one opening below is the history the replay must not move.
  const oldPerson = await employee(OLD, "old-person");
  await q(
    `insert into employee_leave_balance_openings (tenant_id, employee_id, leave_type_id, snapshot_at, opening_balance)
     select $1, $2, id, now() - interval '30 days', 4 from leave_types where tenant_id = $1 and code = 'ANNUAL'`,
    [OLD.tenant, oldPerson],
  );
  await pastLeave(OLD, oldPerson, "TRAINING", day(-20));
  await pastLeave(OLD, oldPerson, "OTHER", day(-19));
  await pastLeave(OLD, oldPerson, "SICK", day(-18));

  console.log("6. existing park groups: 0053 replayed:");
  await check("replayed twice, the same result: Sick, Business and Unpaid for managers only, Training off, Annual and Days Off as they were", async () => {
    const historyBefore = await historyRows(OLD.tenant);
    const untouched = (await typesRows(OLD.tenant)).filter((r) => ["ANNUAL", "CHANGE_DAY_OFF", "OTHER", `ZZ_OWN_${RUN}`].includes(String(r.code)));
    await replay0053();
    const once = await typesRows(OLD.tenant);
    await replay0053();
    const twice = await typesRows(OLD.tenant);
    assert.deepEqual(twice, once, "a second run changes nothing");
    const row = (code: string) => once.find((r) => r.code === code)!;
    for (const code of MANAGERS_ONLY) assert.deepEqual([row(code).managers_only, row(code).is_active], [true, true], code);
    assert.deepEqual([row("TRAINING").is_active, row("TRAINING").managers_only], [false, false]);
    // Untouched, column for column: Annual, Days Off, the park's own type and
    // the Other a manager renamed (it stays on, as the manager left it).
    assert.deepEqual(once.filter((r) => untouched.some((u) => u.id === r.id)), untouched);
    assert.equal(row("OTHER").is_active, true);
    assert.equal(row(`ZZ_OWN_${RUN}`).managers_only, false);
    // The history: no time-off row or opening read differently.
    assert.deepEqual(await historyRows(OLD.tenant), historyBefore);
  });

  // ── The server ──────────────────────────────────────────────────────────────
  const NEW = await parkGroup("new");
  const staffPerson = await employee(NEW, "staff-person", NEW.staff.id);
  ORIGIN = await serve();
  const cookie = {
    admin: await signIn(NEW.admin.email),
    manager: await signIn(NEW.manager.email),
    staff: await signIn(NEW.staff.email),
    oldStaff: await signIn(OLD.staff.email),
  };
  const typesOf = async (c: string) => {
    const res = await call("GET", "/api/leave-types", { cookie: c });
    assert.equal(res.status, 200, show(res));
    return res.body as TypeRow[];
  };

  // ── 2. A new park group ─────────────────────────────────────────────────────
  console.log("2. a new park group's catalogue:");
  await check("made with the owner's set: Sick, Business and Unpaid for managers only; Training and Other off; Annual and Days Off seen by staff", async () => {
    assert.equal(await count("select count(*) as n from leave_types where tenant_id = $1", [NEW.tenant]), 0);
    const all = await typesOf(cookie.admin);
    assert.deepEqual(codes(all), BUILTIN);
    for (const code of MANAGERS_ONLY) assert.deepEqual([byCode(all, code).managersOnly, byCode(all, code).isActive], [true, true], code);
    for (const code of STAFF_SEE) assert.deepEqual([byCode(all, code).managersOnly, byCode(all, code).isActive], [false, true], code);
    for (const code of SWITCHED_OFF) assert.deepEqual([byCode(all, code).managersOnly, byCode(all, code).isActive], [false, false], code);
  });

  // ── 3. The list per role ────────────────────────────────────────────────────
  console.log("3. the list per role:");
  let own: TypeRow;
  await check("staff are shown Annual Leave and Days Off (and the switched-off two, as off); a manager and an admin are shown every type", async () => {
    assert.deepEqual(codes(await typesOf(cookie.staff)), ["ANNUAL", "CHANGE_DAY_OFF", "OTHER", "TRAINING"]);
    assert.ok((await typesOf(cookie.staff)).filter((t) => t.isActive).every((t) => STAFF_SEE.includes(t.code)));
    assert.deepEqual(codes(await typesOf(cookie.manager)), BUILTIN);
    assert.deepEqual(codes(await typesOf(cookie.admin)), BUILTIN);
    // The existing park group, after 0053: its staff are not shown the three either.
    assert.deepEqual(codes(await typesOf(cookie.oldStaff)), ["ANNUAL", "CHANGE_DAY_OFF", "OTHER", "TRAINING", `ZZ_OWN_${RUN}`]);
  });

  await check("a park's own type: made managers only, staff are not shown it; switched to everyone, they are; only an admin changes the setting", async () => {
    const made = await call("POST", "/api/leave-types", { cookie: cookie.admin, body: { name: `ZZ Mgr ${run}`, code: `ZZ_MGR_${RUN}`, accrualMethod: "NONE", managersOnly: true } });
    assert.equal(made.status, 201, show(made));
    own = made.body as TypeRow;
    assert.equal(own.managersOnly, true);
    assert.ok(!codes(await typesOf(cookie.staff)).includes(own.code));
    assert.equal(byCode(await typesOf(cookie.manager), own.code).managersOnly, true);
    const byManager = await call("PATCH", `/api/leave-types/${own.id}`, { cookie: cookie.manager, body: { managersOnly: false } });
    assert.equal(byManager.status, 403, show(byManager));
    const bad = await call("PATCH", `/api/leave-types/${own.id}`, { cookie: cookie.admin, body: { managersOnly: "yes" } });
    assert.equal(bad.status, 400, show(bad));
    const opened = await call("PATCH", `/api/leave-types/${own.id}`, { cookie: cookie.admin, body: { managersOnly: false } });
    assert.equal(opened.status, 200, show(opened));
    assert.equal(byCode(await typesOf(cookie.staff), own.code).managersOnly, false);
    const closed = await call("PATCH", `/api/leave-types/${own.id}`, { cookie: cookie.admin, body: { managersOnly: true } });
    assert.equal(closed.status, 200, show(closed));
    assert.ok(!codes(await typesOf(cookie.staff)).includes(own.code));
    // A type made without the setting is seen by everyone, as every new type was.
    const plain = await call("POST", "/api/leave-types", { cookie: cookie.admin, body: { name: `ZZ Plain ${run}`, code: `ZZ_PLAIN_${RUN}`, accrualMethod: "NONE" } });
    assert.equal(plain.status, 201, show(plain));
    assert.equal(byCode(await typesOf(cookie.staff), `ZZ_PLAIN_${RUN}`).managersOnly, false);
  });

  // ── 4. Recording ───────────────────────────────────────────────────────────
  console.log("4. recording leave:");
  const rows = () => count("select count(*) as n from employee_time_off where employee_id = $1", [staffPerson]);
  const book = (c: string, type: string, date: string) =>
    call("POST", "/api/time-off", { cookie: c, body: { employeeId: staffPerson, branchId: NEW.x, timeOffType: type, startDate: date, endDate: date } });
  let sickRecord = "";
  await check("a manager records Sick Leave, Unpaid Leave and the park's own managers-only type for a staff member", async () => {
    const sick = await book(cookie.manager, "SICK", day(30));
    assert.equal(sick.status, 201, show(sick));
    assert.equal(sick.body.type, "SICK");
    sickRecord = sick.body.id;
    assert.equal((await book(cookie.manager, "unpaid", day(31))).status, 201);
    assert.equal((await book(cookie.admin, own.code, day(32))).status, 201);
  });

  await check("staff record nothing, a managers-only type or not (the app's manager rule, as before), and nothing is saved", async () => {
    const n = await rows();
    for (const type of ["SICK", "BUSINESS", own.code, "ANNUAL"]) {
      const res = await book(cookie.staff, type, day(40));
      assert.equal(res.status, 403, `${type}: ${show(res)}`);
    }
    assert.equal((await call("PATCH", `/api/time-off/${sickRecord}`, { cookie: cookie.staff, body: { timeOffType: "ANNUAL" } })).status, 403);
    assert.equal(await rows(), n);
  });

  await check("Training and Other can no longer be chosen by anyone, new or changed; switched back on by an admin, a manager may record one again", async () => {
    const n = await rows();
    for (const c of [cookie.manager, cookie.admin]) {
      for (const type of SWITCHED_OFF) {
        const res = await book(c, type, day(50));
        assert.equal(res.status, 400, `${type}: ${show(res)}`);
        assert.deepEqual(res.body, { message: "Unknown or inactive leave type" });
      }
    }
    const changed = await call("PATCH", `/api/time-off/${sickRecord}`, { cookie: cookie.manager, body: { timeOffType: "training" } });
    assert.equal(changed.status, 400, show(changed));
    assert.equal(await rows(), n);
    assert.equal((await q<{ type: string }>("select type from employee_time_off where id = $1", [sickRecord]))[0]!.type, "SICK");
    // The setting is the park's to change: Training on again books.
    const training = byCode(await typesOf(cookie.admin), "TRAINING");
    assert.equal((await call("PATCH", `/api/leave-types/${training.id}`, { cookie: cookie.admin, body: { isActive: true } })).status, 200);
    assert.equal((await book(cookie.manager, "TRAINING", day(51))).status, 201);
    assert.equal((await call("PATCH", `/api/leave-types/${training.id}`, { cookie: cookie.admin, body: { isActive: false } })).status, 200);
    // A manager moves a record between types they may record.
    const moved = await call("PATCH", `/api/time-off/${sickRecord}`, { cookie: cookie.manager, body: { timeOffType: "BUSINESS" } });
    assert.equal(moved.status, 200, show(moved));
    assert.equal(moved.body.type, "BUSINESS");
  });

  // ── 5. Nothing lost ─────────────────────────────────────────────────────────
  console.log("5. nothing lost:");
  await check("a staff member's own history keeps every type: Training and Other already taken, and the managers-only leave recorded for them", async () => {
    const pastTraining = await pastLeave(NEW, staffPerson, "TRAINING", day(-10));
    const pastOther = await pastLeave(NEW, staffPerson, "OTHER", day(-9));
    const mine = await call("GET", `/api/my-time-off?dateFrom=${day(-60)}&dateTo=${day(90)}`, { cookie: cookie.staff });
    assert.equal(mine.status, 200, show(mine));
    const seen = new Map((mine.body.timeOff as { id: string; type: string }[]).map((r) => [r.id, r.type]));
    assert.equal(seen.get(pastTraining), "TRAINING");
    assert.equal(seen.get(pastOther), "OTHER");
    assert.equal(seen.get(sickRecord), "BUSINESS");
    assert.deepEqual([...seen.values()].sort(), ["BUSINESS", "OTHER", "TRAINING", "TRAINING", "UNPAID", own.code].sort());
  });

  await check("a staff member's own balances still count every type, the managers-only and the switched-off ones included", async () => {
    const res = await call("GET", `/api/employees/${staffPerson}/leave-balances-dynamic?year=${thisYear}`, { cookie: cookie.staff });
    assert.equal(res.status, 200, show(res));
    const balances = res.body.balances as { code: string; used: number; isActive: boolean }[];
    for (const code of BUILTIN) assert.ok(balances.some((b) => b.code === code), `balance for ${code}`);
    assert.ok(balances.some((b) => b.code === own.code), "balance for the park's own managers-only type");
    // The days already taken are counted where they fall in this year.
    const inYear = (offset: number) => Number(day(offset).slice(0, 4)) === thisYear;
    if (inYear(-10)) assert.ok(byCode(balances, "TRAINING").used >= 1, "Training already taken is counted");
    if (inYear(-9)) assert.ok(byCode(balances, "OTHER").used >= 1, "Other already taken is counted");
    assert.equal(byCode(balances, "TRAINING").isActive, false);
  });

  await check("the existing park group's history after 0053: every row as it was, the old Training and Other leave still the person's", async () => {
    assert.deepEqual(
      (await q<{ type: string }>("select type from employee_time_off where tenant_id = $1 order by type", [OLD.tenant])).map((r) => r.type),
      ["OTHER", "SICK", "TRAINING"],
    );
    assert.equal(await count("select count(*) as n from employee_leave_balance_openings where tenant_id = $1", [OLD.tenant]), 1);
  });

  console.log(`leave-type-audience.check: ${checks} checks passed`);
} catch (err) {
  console.error("leave-type-audience.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
