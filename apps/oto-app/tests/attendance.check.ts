// seed: its own — three park groups' worth of ZZ TEST rows, made here (the
// slug-`default` park group only when the database has none). Not a
// Playwright file (the suite collects *.spec.ts and *.test.ts; this is
// neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated.
//
// S2-17b round 5 — attendance and operations as the app does them, over HTTP
// against the routes as registered (plan section 8 round 5; hazards H13-H15;
// questions Q1, Q2, Q9, Q10 and Q38 onwards):
//
//   1. Leave approval restored (Q1, H14): the rota's own request makes the
//      sick day as approved; created as approved, exactly that person's
//      assignments on those Bangkok days are freed with one coverage alert per
//      freed shift, each in the person's park group — and the app's own order,
//      which refuses a day that already has a shift before anything else, is
//      kept; approved later, their legacy shifts in the range are unassigned;
//      a repeat approve changes nothing more; nothing new is stored.
//   2. The shift-row refusal (Q2, H15): every door that would leave a rota row
//      with no shift group answers 400 in words and writes nothing.
//   3. Casual workers' ungrouped-row case: a branch with no shift group yet
//      is told to choose one; with one, a casual worker is scheduled as the
//      app does it.
//   4. Face "off" refuses instead of matching (H13), with an ENROLLED person
//      present: no matcher is called, enrolment is refused, and no door of
//      the face road writes a time event; PIN and phone still clock in.
//   5. A configured-device reception action: a tablet activated from a code
//      for its branch works its own branch's check-ins and nothing else's,
//      and a code for another park group's branch is not minted.
//   6. Restricted-branch proof for scheduling, leave, checklists,
//      announcements and notifications: a manager limited to one branch reads
//      and writes that branch's rows where the app has a branch rule; where a
//      door has none, the check pins what it does today as a FINDING (each
//      one a question in the plan, never a rule added here).
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/attendance.check.ts
// The platform's suite runs it the same way against a fresh test database
// when the app's node_modules are present (apps/api/test/s217b-r5.test.ts).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { FACE_CLOCK_OFF_REFUSAL, FACE_ENROLMENT_OFF_REFUSAL, FACE_OFF_NO_MATCH } from "../server/lib/faceOff";
import { SHIFT_GROUP_DELETE_NEEDS_TARGET, SHIFT_GROUP_REQUIRED } from "../server/lib/shiftGroupRequired";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("attendance.check: DATABASE_URL is not set");
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
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");

/** A Bangkok calendar date `n` days from today. */
const day = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
/** The day before a YYYY-MM-DD date. */
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

// ─── The default park group and our own ──────────────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");

interface ParkGroup {
  tenant: string;
  /** Branch X: the limited manager's branch. */
  x: string;
  /** Branch Y: the same park group's other branch. */
  y: string;
  admin: { id: string; email: string };
  /** A manager limited to branch X. */
  limited: { id: string; email: string };
  department: string;
  role: string;
}

async function user(tenant: string, role: string, email: string, branch: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role} ${run}`, role],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    tenant,
    id,
    branch,
    branch ? "selected_branches" : "all_branches",
  ]);
  return id;
}

async function employee(tenant: string, branch: string, label: string, fields: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const cols = ["id", "tenant_id", "branch_id", "full_name", "nickname", "email", "status", ...Object.keys(fields)];
  const vals = [id, tenant, branch, `ZZ TEST ${run} ${label}`, "ZZ", `zz-r5-${label}-${id.slice(0, 8)}@example.com`, "active", ...Object.values(fields)];
  await q(`insert into employees (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST r5 ${label} ${run}`, `zz-r5-${label}-${run}`]);
  const x = randomUUID();
  const y = randomUUID();
  for (const [id, suffix] of [[x, "x"], [y, "y"]] as const) {
    await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
      id,
      tenant,
      `ZZ TEST r5 ${label} ${suffix} ${run}`,
    ]);
  }
  const department = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [department, tenant, `ZZ TEST r5 ${label} ${run}`]);
  const role = randomUUID();
  await q("insert into roles (id, tenant_id, name) values ($1, $2, $3)", [role, tenant, `ZZ TEST r5 ${label} ${run}`]);
  const adminEmail = `zz-r5-${label}-admin-${run}@example.com`;
  const limitedEmail = `zz-r5-${label}-limited-${run}@example.com`;
  return {
    tenant,
    x,
    y,
    admin: { id: await user(tenant, "admin", adminEmail, null), email: adminEmail },
    limited: { id: await user(tenant, "manager", limitedEmail, x), email: limitedEmail },
    department,
    role,
  };
}

const A = await parkGroup("a");
const B = await parkGroup("b");

/** A week plan, a shift group and two rows in a branch, made directly. */
async function rota(g: ParkGroup, branch: string) {
  const plan = randomUUID();
  await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [plan, g.tenant, branch, day(0)]);
  const group = randomUUID();
  await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [group, g.tenant, branch, `ZZ TEST r5 ${run}`]);
  const rows: string[] = [];
  for (const [start, end] of [["09:00", "17:00"], ["18:00", "22:00"]]) {
    const row = randomUUID();
    await q(
      `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
       values ($1, $2, $3, $4, $5, $6, $7, 'ZZ TEST')`,
      [row, g.tenant, branch, group, plan, start, end],
    );
    rows.push(row);
  }
  return { plan, group, r1: rows[0]!, r2: rows[1]! };
}

async function assignment(g: ParkGroup, plan: string, row: string, date: string, employeeId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, g.tenant, plan, row, date, employeeId],
  );
  return id;
}

/** A shift in the app's older shift list (`shifts`), which no screen writes any more. */
async function legacyShift(g: ParkGroup, branch: string, employeeId: string, startAt: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into shifts (id, tenant_id, branch_id, department_id, start_at, end_at, employee_id, status, created_by)
     values ($1, $2, $3, $4, $5::timestamp, $5::timestamp + interval '8 hours', $6, 'ASSIGNED', $7)`,
    [id, g.tenant, branch, g.department, startAt, employeeId, g.admin.id],
  );
  return id;
}

// ─── The server ──────────────────────────────────────────────────────────────

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
  // Face clock-in off, as on staging and as production's boot guard insists.
  USE_AWS_REKOGNITION: "false",
};

/** The harness, and everything it has printed so far (the matcher would print if it were called). */
async function serve(env: Record<string, string> = {}): Promise<{ origin: string; output: () => string }> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "tests/harness/serve-routes.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  const origin = await new Promise<string>((resolve, reject) => {
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
  return { origin, output: () => output };
}

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}

let ORIGIN = "";
async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
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

const CONCURRENT = `zz_r5_concurrent_${run}`;

try {
  const server = await serve();
  ORIGIN = server.origin;
  const cookie = {
    a: await signIn(A.admin.email),
    aLimited: await signIn(A.limited.email),
    b: await signIn(B.admin.email),
  };

  // ── 1. Leave approval restored (Q1, H14) ────────────────────────────────────
  console.log("1. leave approval, as the app does it (Q1, H14):");
  const sick = await employee(A.tenant, A.x, "sick");
  const other = await employee(A.tenant, A.x, "other");
  const parked = await employee(A.tenant, A.x, "parked");
  const leaveRota = await rota(A, A.x);
  const coverageItems = () =>
    q<{ tenant_id: string; branch_id: string; employee_id: string; type: string; rule_key: string; entity_key: string; severity: string; title: string; status: string }>(
      `select tenant_id, branch_id, employee_id, type, rule_key, entity_key, severity, title, status
         from attention_items where employee_id = $1 and rule_key = 'SICK_LEAVE_COVERAGE' order by entity_key`,
      [sick],
    );
  const timeOffColumns = async () =>
    (await q<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'otoapp' and table_name = 'employee_time_off' order by column_name`,
    )).map((r) => r.column_name);
  const columnsBefore = await timeOffColumns();

  // A shift assigned at the same moment the sick day is saved: the only way
  // the app's freeing step ever finds anything (see the order check below).
  // A trigger re-points parked assignments to the person when their day off
  // lands, between the route's conflict check and its freeing step.
  await q(`create table ${CONCURRENT} (note text not null, assignment_id varchar not null)`);
  await q(`create function ${CONCURRENT}() returns trigger language plpgsql as $$
           begin
             update schedule_assignments set employee_id = new.employee_id
              where id in (select assignment_id from ${CONCURRENT} where note = new.note);
             return new;
           end $$`);
  await q(`create trigger ${CONCURRENT} after insert on employee_time_off for each row execute function ${CONCURRENT}()`);
  const concurrently = async (note: string, rows: Array<[string, string]>) => {
    const ids: string[] = [];
    for (const [row, date] of rows) {
      const id = await assignment(A, leaveRota.plan, row, date, parked);
      await q(`insert into ${CONCURRENT} (note, assignment_id) values ($1, $2)`, [note, id]);
      ids.push(id);
    }
    return ids;
  };
  const owner = async (ids: string[]) =>
    (await q<{ id: string; employee_id: string }>("select id, employee_id from schedule_assignments where id = any($1)", [ids]));

  await check("the rota's own request (the restored client body, approved: true) makes the sick day, and stores no approval", async () => {
    const d = day(30);
    const res = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: sick, branchId: A.x, timeOffType: "SICK", startDate: d, endDate: d, approved: true },
    });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.type, "SICK");
    for (const key of Object.keys(res.body)) assert.ok(!/approv/i.test(key), `nothing about approval is stored: ${key}`);
    const [row] = await q<{ s: string; e: string }>(
      "select start_date::date::text as s, end_date::date::text as e from employee_time_off where id = $1",
      [res.body.id],
    );
    assert.deepEqual(row, { s: d, e: d });
  });

  await check("the app's order: a day the person already has a shift on is refused before anything is saved or freed (409, the app's words)", async () => {
    const d = day(31);
    const theirs = await assignment(A, leaveRota.plan, leaveRota.r1, d, sick);
    const res = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: sick, branchId: A.x, timeOffType: "SICK", startDate: d, endDate: d, approved: true },
    });
    assert.equal(res.status, 409, show(res));
    assert.equal(res.body.message, `Cannot add time-off: employee has a shift on ${d}. Please remove the shift first.`);
    assert.deepEqual((await owner([theirs])).map((a) => a.employee_id), [sick], "the shift is not freed");
    assert.equal(await count("select count(*) as n from employee_time_off where employee_id = $1 and start_date::date = $2::date", [sick, d]), 0);
    assert.deepEqual(await coverageItems(), []);
  });

  const [d1, d2] = [day(40), day(41)];
  const d0 = dayBefore(d1);
  const d3 = day(42);
  await check("created as approved: exactly that person's assignments on those Bangkok days are freed, one coverage alert per freed shift, each in the person's park group", async () => {
    const freed = await concurrently("ZZ concurrent sick", [[leaveRota.r1, d1], [leaveRota.r2, d1], [leaveRota.r1, d2]]);
    // The day before (d0) is the UTC date of the start the request names, but
    // not a Bangkok day of the leave: re-pointed too, and not freed.
    const [beforeDay] = await concurrently("ZZ concurrent sick", [[leaveRota.r1, d0]]);
    const afterDay = await assignment(A, leaveRota.plan, leaveRota.r1, d3, sick);
    const someoneElse = await assignment(A, leaveRota.plan, leaveRota.r1, d1, other);
    const res = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: {
        employeeId: sick,
        branchId: A.x,
        timeOffType: "SICK",
        // 00:30 Bangkok on d1 is 17:30 UTC the day before: the leave is on the
        // Bangkok calendar (the lift's Bangkok fix), d1 and d2.
        startDate: `${d1}T00:30:00+07:00`,
        endDate: `${d2}T00:30:00+07:00`,
        notes: "ZZ concurrent sick",
        approved: true,
      },
    });
    assert.equal(res.status, 201, show(res));
    assert.deepEqual(await owner(freed), [], "the three shifts on d1 and d2 are freed");
    assert.deepEqual((await owner([beforeDay!])).map((a) => a.employee_id), [sick], "the day before stays");
    assert.deepEqual((await owner([afterDay])).map((a) => a.employee_id), [sick], "the day after stays");
    assert.deepEqual((await owner([someoneElse])).map((a) => a.employee_id), [other], "another person's shift that day stays");
    const items = await coverageItems();
    assert.deepEqual(
      items.map((i) => i.entity_key),
      [`${leaveRota.r1}_${d1}`, `${leaveRota.r1}_${d2}`, `${leaveRota.r2}_${d1}`].sort(),
      "one alert per freed shift",
    );
    for (const item of items) {
      assert.equal(item.tenant_id, A.tenant, "in the person's park group");
      assert.equal(item.branch_id, A.x);
      assert.equal(item.type, "SHIFT_NEEDS_COVERAGE");
      assert.equal(item.status, "open");
      assert.equal(item.severity, "low", "graded by how soon the shift is: weeks away");
    }
    const monthDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    assert.ok(items.some((i) => i.title === `Shift needs coverage: 18:00-22:00 on ${monthDay(d1)}`), JSON.stringify(items.map((i) => i.title)));
  });

  await check("only SICK and only approved: annual leave and an unapproved sick day free nothing and raise nothing", async () => {
    const [annualDay, unapprovedDay] = [day(50), day(52)];
    const annual = await concurrently("ZZ concurrent annual", [[leaveRota.r1, annualDay]]);
    const unapproved = await concurrently("ZZ concurrent unapproved", [[leaveRota.r1, unapprovedDay]]);
    const before = (await coverageItems()).length;
    for (const [type, d, note, approved] of [
      ["ANNUAL", annualDay, "ZZ concurrent annual", true],
      ["SICK", unapprovedDay, "ZZ concurrent unapproved", undefined],
    ] as const) {
      const res = await call("POST", "/api/time-off", {
        cookie: cookie.a,
        body: { employeeId: sick, branchId: A.x, timeOffType: type, startDate: d, endDate: d, notes: note, ...(approved ? { approved } : {}) },
      });
      assert.equal(res.status, 201, show(res));
    }
    assert.deepEqual((await owner([...annual, ...unapproved])).map((a) => a.employee_id), [sick, sick]);
    assert.equal((await coverageItems()).length, before);
  });

  const legacy = async (id: string) =>
    (await q<{ employee_id: string | null; status: string; needs_coverage: boolean; updated_at: Date }>(
      "select employee_id, status, needs_coverage, updated_at from shifts where id = $1",
      [id],
    ))[0]!;
  await check("created as approved also unassigns the person's legacy shifts over the app's range, flagged for coverage (Q38: first day 00:00 UTC to last day 00:00 UTC)", async () => {
    const [l1, l2] = [day(60), day(61)];
    const inRange = await legacyShift(A, A.x, sick, `${l1} 02:00:00`);
    const lastDayMorning = await legacyShift(A, A.x, sick, `${l2} 02:00:00`);
    const res = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: sick, branchId: A.x, timeOffType: "SICK", startDate: l1, endDate: l2, approved: true },
    });
    assert.equal(res.status, 201, show(res));
    assert.deepEqual(
      { ...(await legacy(inRange)), updated_at: undefined },
      { employee_id: null, status: "OPEN", needs_coverage: true, updated_at: undefined },
    );
    // The app's range ends at the last day's midnight UTC: a 09:00 Bangkok
    // shift on the last day is not reached (Q38).
    assert.equal((await legacy(lastDayMorning)).employee_id, sick);
  });

  await check("approved later: their legacy shifts in the range are unassigned; the new rota is not touched; nothing is stored", async () => {
    const [p1, p2] = [day(70), day(71)];
    const made = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: sick, branchId: A.x, timeOffType: "SICK", startDate: p1, endDate: p2 },
    });
    assert.equal(made.status, 201, show(made));
    const morning = await legacyShift(A, A.x, sick, `${p1} 02:00:00`);
    const someoneElses = await legacyShift(A, A.x, other, `${p1} 02:00:00`);
    // A rota assignment that day (written straight to the table: the route
    // would refuse it over the day off).
    const onTheRota = await assignment(A, leaveRota.plan, leaveRota.r1, p1, sick);
    const itemsBefore = (await coverageItems()).length;
    const [rowBefore] = await q("select * from employee_time_off where id = $1", [made.body.id]);
    const res = await call("PATCH", `/api/time-off/${made.body.id}`, { cookie: cookie.a, body: { approved: true } });
    assert.equal(res.status, 200, show(res));
    assert.equal((await legacy(morning)).employee_id, null);
    assert.equal((await legacy(morning)).needs_coverage, true);
    assert.equal((await legacy(someoneElses)).employee_id, other, "another person's legacy shift stays");
    assert.deepEqual((await owner([onTheRota])).map((a) => a.employee_id), [sick], "approving later does not touch the rota (the app's shape)");
    assert.equal((await coverageItems()).length, itemsBefore, "approving later raises no alert (the app's shape)");
    const [rowAfter] = await q("select * from employee_time_off where id = $1", [made.body.id]);
    assert.deepEqual({ ...rowAfter, updated_at: null }, { ...rowBefore, updated_at: null }, "nothing but updated_at changes");
  });

  await check("a repeat approve changes nothing more", async () => {
    const [r1] = [day(80)];
    const made = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: sick, branchId: A.x, timeOffType: "SICK", startDate: r1, endDate: r1 },
    });
    assert.equal(made.status, 201, show(made));
    const midnight = await legacyShift(A, A.x, sick, `${r1} 00:00:00`);
    assert.equal((await call("PATCH", `/api/time-off/${made.body.id}`, { cookie: cookie.a, body: { approved: true } })).status, 200);
    const once = await legacy(midnight);
    assert.equal(once.employee_id, null);
    const items = (await coverageItems()).length;
    const again = await call("PATCH", `/api/time-off/${made.body.id}`, { cookie: cookie.a, body: { approved: true } });
    assert.equal(again.status, 200, show(again));
    assert.deepEqual(await legacy(midnight), once, "the legacy shift is not written again");
    assert.equal((await coverageItems()).length, items);
  });

  await check("annual leave approved later changes nothing; the table has no approval column, before or after", async () => {
    const a1 = day(90);
    const made = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: sick, branchId: A.x, timeOffType: "ANNUAL", startDate: a1, endDate: a1 },
    });
    assert.equal(made.status, 201, show(made));
    const shift = await legacyShift(A, A.x, sick, `${a1} 00:00:00`);
    assert.equal((await call("PATCH", `/api/time-off/${made.body.id}`, { cookie: cookie.a, body: { approved: true } })).status, 200);
    assert.equal((await legacy(shift)).employee_id, sick);
    const columns = await timeOffColumns();
    assert.deepEqual(columns, columnsBefore);
    assert.ok(!columns.some((c) => /approv/.test(c)), columns.join(","));
  });

  // ── 2. The shift-row refusal (Q2, H15) ──────────────────────────────────────
  console.log("2. a rota row always has a shift group (Q2, H15):");
  const rowsIn = (branch: string) => count("select count(*) as n from schedule_shift_rows where branch_id = $1", [branch]);
  const groupOf = async (row: string) => (await q<{ shift_group_id: string }>("select shift_group_id from schedule_shift_rows where id = $1", [row]))[0]!.shift_group_id;
  const h15 = await rota(A, A.y);
  await check("creating a row with no group (absent, null or empty) answers 400 in words and writes no row", async () => {
    const before = await rowsIn(A.y);
    for (const group of [undefined, null, ""]) {
      const res = await call("POST", "/api/schedule/shift-rows", {
        cookie: cookie.a,
        body: { branchId: A.y, startTime: "10:00", endTime: "18:00", label: "ZZ TEST", ...(group === undefined ? {} : { shiftGroupId: group }) },
      });
      assert.equal(res.status, 400, show(res));
      assert.deepEqual(res.body, SHIFT_GROUP_REQUIRED);
    }
    assert.equal(await rowsIn(A.y), before);
    const ok = await call("POST", "/api/schedule/shift-rows", {
      cookie: cookie.a,
      body: { branchId: A.y, startTime: "10:00", endTime: "18:00", label: "ZZ TEST", shiftGroupId: h15.group },
    });
    assert.equal(ok.status, 201, show(ok));
    assert.equal(await rowsIn(A.y), before + 1);
  });
  await check("editing or dragging a row to no group is the same 400, and the row keeps its group; a move between groups works", async () => {
    const other = randomUUID();
    await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [other, A.tenant, A.y, `ZZ TEST r5 other ${run}`]);
    for (const [method, path] of [["PATCH", `/api/schedule/shift-rows/${h15.r1}`], ["PATCH", `/api/schedule/shift-rows/${h15.r1}/move-group`]] as const) {
      for (const group of [null, ""]) {
        const res = await call(method, path, { cookie: cookie.a, body: { shiftGroupId: group } });
        assert.equal(res.status, 400, `${path}: ${show(res)}`);
        assert.deepEqual(res.body, SHIFT_GROUP_REQUIRED);
        assert.equal(await groupOf(h15.r1), h15.group);
      }
    }
    const label = await call("PATCH", `/api/schedule/shift-rows/${h15.r1}`, { cookie: cookie.a, body: { label: "ZZ TEST renamed" } });
    assert.equal(label.status, 200, show(label));
    const moved = await call("PATCH", `/api/schedule/shift-rows/${h15.r2}/move-group`, { cookie: cookie.a, body: { shiftGroupId: other } });
    assert.equal(moved.status, 200, show(moved));
    assert.equal(await groupOf(h15.r2), other);
  });
  await check("deleting a group that still has rows, without saying where they go, is refused in words and changes nothing; with a target it moves them", async () => {
    const res = await call("DELETE", `/api/schedule/shift-groups/${h15.group}`, { cookie: cookie.a });
    assert.equal(res.status, 400, show(res));
    assert.deepEqual(res.body, SHIFT_GROUP_DELETE_NEEDS_TARGET);
    assert.equal(await count("select count(*) as n from shift_groups where id = $1", [h15.group]), 1);
    assert.equal(await groupOf(h15.r1), h15.group);
    const target = await groupOf(h15.r2);
    const ok = await call("DELETE", `/api/schedule/shift-groups/${h15.group}?targetGroupId=${target}`, { cookie: cookie.a });
    assert.equal(ok.status, 204, show(ok));
    assert.equal(await groupOf(h15.r1), target);
    const empty = randomUUID();
    await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [empty, A.tenant, A.y, `ZZ TEST r5 empty ${run}`]);
    assert.equal((await call("DELETE", `/api/schedule/shift-groups/${empty}`, { cookie: cookie.a })).status, 204, "an empty group deletes as before");
  });

  // ── 3. Casual workers' ungrouped-row case ───────────────────────────────────
  console.log("3. casual workers on a branch with no shift group yet:");
  await check("the first shift is refused in words until a group exists; then the casual worker is scheduled at their daily rate, as the app does it", async () => {
    const fresh = randomUUID();
    await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [fresh, A.tenant, `ZZ TEST r5 casual ${run}`]);
    assert.equal(await count("select count(*) as n from shift_groups where branch_id = $1", [fresh]), 0);
    const worker = await call("POST", "/api/casual-workers", {
      cookie: cookie.a,
      body: { fullName: `ZZ TEST casual ${run}`, nickname: "ZZ", branchId: fresh, departmentId: A.department, roleId: A.role, startDate: day(0), endDate: day(120), dailyRate: 650 },
    });
    assert.equal(worker.status, 201, show(worker));
    const refused = await call("POST", "/api/schedule/shift-rows", { cookie: cookie.a, body: { branchId: fresh, startTime: "10:00", endTime: "18:00", label: "ZZ TEST casual" } });
    assert.equal(refused.status, 400, show(refused));
    assert.deepEqual(refused.body, SHIFT_GROUP_REQUIRED);
    assert.equal(await rowsIn(fresh), 0);
    const group = await call("POST", "/api/schedule/shift-groups", { cookie: cookie.a, body: { branchId: fresh, name: `ZZ TEST casual ${run}` } });
    assert.equal(group.status, 201, show(group));
    const row = await call("POST", "/api/schedule/shift-rows", {
      cookie: cookie.a,
      body: { branchId: fresh, startTime: "10:00", endTime: "18:00", label: "ZZ TEST casual", shiftGroupId: group.body.id },
    });
    assert.equal(row.status, 201, show(row));
    const shiftDate = day(14);
    const assigned = await call("POST", "/api/schedule/assignments", {
      cookie: cookie.a,
      body: { shiftRowId: row.body.id, shiftDate, casualWorkerId: worker.body.id, assigneeType: "casual" },
    });
    assert.equal(assigned.status, 201, show(assigned));
    assert.equal(assigned.body.assigneeType, "casual");
    assert.equal(assigned.body.casualWorkerId, worker.body.id);
    assert.equal(assigned.body.employeeId, null);
    assert.equal(assigned.body.dailyRateSnapshot, 650);
  });

  // ── 4. Face "off" refuses instead of matching (H13) ─────────────────────────
  console.log("4. face clock-in off, with an ENROLLED person present (H13):");
  const PIN = "4821";
  const PHONE_LOCAL = `08${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const enrolled = await employee(A.tenant, A.x, "enrolled", {
    face_enrollment_status: "ENROLLED",
    face_id: `face_zz_${run}`,
    face_enrolled_at: new Date(),
    timeclock_pin_hash: sha256(PIN),
    phone_e164: `+66${PHONE_LOCAL.slice(1)}`,
  });
  const deviceSecret = randomBytes(32).toString("hex");
  const faceDevice = randomUUID();
  await q(
    `insert into kiosk_devices (id, tenant_id, branch_id, name, device_secret_hash, kiosk_type, is_active)
     values ($1, $2, $3, 'ZZ TEST face tablet', $4, 'face_recognition', true)`,
    [faceDevice, A.tenant, A.x, sha256(deviceSecret)],
  );
  const writtenFor = async (employeeId: string) => ({
    timeEvents: await count("select count(*) as n from time_events where employee_id = $1", [employeeId]),
    timeEntries: await count("select count(*) as n from time_entries where employee_id = $1", [employeeId]),
    issues: await count("select count(*) as n from timekeeping_issues where employee_id = $1", [employeeId]),
    attempts: await count("select count(*) as n from kiosk_auth_attempts where employee_id = $1", [employeeId]),
  });
  const nothing = { timeEvents: 0, timeEntries: 0, issues: 0, attempts: 0 };
  const faceRow = async () =>
    (await q("select face_enrollment_status, face_id, face_enrolled_at, profile_photo_path from employees where id = $1", [enrolled]))[0];
  const faceBefore = await faceRow();

  await check("identify-face answers the app's own \"no match, use PIN\" — and no matcher, liveness or search, is called", async () => {
    const res = await call("POST", "/api/kiosk/identify-face", {
      body: { faceImageBase64: "zz", faceFramesBase64: ["zz1", "zz2", "zz3", "zz4", "zz5"], deviceSecret },
    });
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body, FACE_OFF_NO_MATCH);
    assert.ok(!/MockFaceRecognition|AWSRekognition\]|\[IdentifyFace\]/.test(server.output()), "the matcher printed nothing");
    // Who may ask is unchanged: no kiosk credential, the app's refusal.
    const anonymous = await call("POST", "/api/kiosk/identify-face", { body: { faceImageBase64: "zz", faceFramesBase64: ["1", "2", "3"] } });
    assert.equal(anonymous.status, 401, show(anonymous));
  });
  await check("/api/kiosk/clock from the paired tablet naming the enrolled person is refused in words and writes no time event", async () => {
    const res = await call("POST", "/api/kiosk/clock", { body: { employeeId: enrolled, confidenceScore: 99.4, livenessScore: 97, deviceSecret } });
    assert.equal(res.status, 403, show(res));
    assert.deepEqual(res.body, FACE_CLOCK_OFF_REFUSAL);
    assert.deepEqual(await writtenFor(enrolled), nothing);
  });
  await check("the face road's other doors (missed clock-in auto-fix and manual, unscheduled clock-in, the advisor's clock) are refused and write nothing", async () => {
    const shiftDate = day(0);
    const doors: Array<[string, Record<string, unknown>]> = [
      ["/api/kiosk/missed-clock/auto-fix", { employeeId: enrolled, branchId: A.x, scheduledStart: `${shiftDate}T02:00:00Z`, scheduledEnd: `${shiftDate}T10:00:00Z`, shiftDate, deviceSecret }],
      ["/api/kiosk/missed-clock/manual", { employeeId: enrolled, branchId: A.x, scheduledStart: `${shiftDate}T02:00:00Z`, scheduledEnd: `${shiftDate}T10:00:00Z`, shiftDate, userClockInAt: `${shiftDate}T02:30:00Z`, reasonCode: "FORGOT_TO_CLOCK_IN", deviceSecret }],
      ["/api/kiosk/unscheduled-clock-in", { employeeId: enrolled, branchId: A.x, reasonCode: "OTHER", deviceSecret }],
      ["/api/kiosk/advisor-clock", { identificationProof: "zz", deviceSecret }],
    ];
    for (const [path, body] of doors) {
      const res = await call("POST", path, { body });
      assert.equal(res.status, 403, `${path}: ${show(res)}`);
      assert.deepEqual(res.body, FACE_CLOCK_OFF_REFUSAL);
    }
    assert.deepEqual(await writtenFor(enrolled), nothing);
    assert.equal(await count("select count(*) as n from advisor_attendance_sessions where kiosk_device_id = $1", [faceDevice]), 0);
  });
  await check("enrolment is refused in words at each of its four doors, and the enrolled face is left as it was", async () => {
    const sessionsBefore = await count("select count(*) as n from enrollment_sessions where employee_id = $1", [enrolled]);
    const manager = [
      [`/api/employees/${enrolled}/enrollment-session`, {}],
      [`/api/people/${randomUUID()}/advisor-enrollment-session`, {}],
    ] as const;
    for (const [path, body] of manager) {
      const res = await call("POST", path, { cookie: cookie.a, body });
      assert.equal(res.status, 403, `${path}: ${show(res)}`);
      assert.deepEqual(res.body, FACE_ENROLMENT_OFF_REFUSAL);
    }
    const tablet = [
      ["/api/kiosk/verify-enrollment-token", { token: "zz", deviceSecret }],
      ["/api/kiosk/complete-enrollment", { sessionId: randomUUID(), enrollmentToken: "zz", faceImageBase64: "zz", consentGiven: true, deviceSecret }],
    ] as const;
    for (const [path, body] of tablet) {
      const res = await call("POST", path, { body });
      assert.equal(res.status, 403, `${path}: ${show(res)}`);
      assert.deepEqual(res.body, FACE_ENROLMENT_OFF_REFUSAL);
    }
    assert.equal(await count("select count(*) as n from enrollment_sessions where employee_id = $1", [enrolled]), sessionsBefore);
    assert.deepEqual(await faceRow(), faceBefore);
    assert.ok(!/MockFaceRecognition/.test(server.output()), "the matcher printed nothing");
  });
  await check("the PIN and phone roads are unchanged: the same tablet clocks the person in by PIN and out by phone", async () => {
    const pin = await call("POST", "/api/kiosk/clock-pin", { body: { employeeId: enrolled, pin: PIN, photoEvidenceUrl: "", deviceSecret } });
    assert.equal(pin.status, 200, show(pin));
    assert.equal(pin.body.eventType, "IN");
    const phone = await call("POST", "/api/kiosk/clock-phone", { body: { phone: PHONE_LOCAL, photoEvidenceUrl: "", deviceSecret } });
    assert.equal(phone.status, 200, show(phone));
    assert.equal(phone.body.eventType, "OUT");
    const events = await q<{ auth_method: string; event_type: string; kiosk_device_id: string }>(
      "select auth_method, event_type, kiosk_device_id from time_events where employee_id = $1 order by event_time",
      [enrolled],
    );
    assert.deepEqual(events, [
      { auth_method: "PIN", event_type: "IN", kiosk_device_id: faceDevice },
      { auth_method: "PHONE_FALLBACK", event_type: "OUT", kiosk_device_id: faceDevice },
    ]);
  });

  // ── 5. A configured-device reception action ─────────────────────────────────
  console.log("5. the reception tablet, configured from a code:");
  const checkin = async (g: ParkGroup, branch: string, label: string) => {
    const id = randomUUID();
    await q(
      `insert into service_checkins (id, tenant_id, branch_id, status, parent_full_name, whatsapp_phone_raw, child_full_name)
       values ($1, $2, $3, 'registered', 'ZZ TEST parent', '+66000000000', $4)`,
      [id, g.tenant, branch, `ZZ TEST ${label} ${run}`],
    );
    return id;
  };
  const cx = await checkin(A, A.x, "x");
  const cy = await checkin(A, A.y, "y");
  const cz = await checkin(B, B.x, "z");
  const ours = new Set([cx, cy, cz]);
  const statusOf = async (id: string) => (await q<{ status: string }>("select status from service_checkins where id = $1", [id]))[0]!.status;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  let tablet: { token: string; deviceSecret: string; device: { id: string; branchId: string } } | undefined;

  await check("a manager makes a code for their branch; the tablet exchanges it once for its session and device secret", async () => {
    const code = await call("POST", `/api/branches/${A.x}/kiosk-code`, { cookie: cookie.aLimited });
    assert.equal(code.status, 200, show(code));
    assert.ok(typeof code.body.code === "string" && code.body.setupUrl.includes("/kiosk/reception?code="));
    const exchanged = await call("POST", "/api/kiosk/exchange", { body: { code: code.body.code } });
    assert.equal(exchanged.status, 200, show(exchanged));
    tablet = exchanged.body;
    assert.equal(tablet!.device.branchId, A.x);
    const again = await call("POST", "/api/kiosk/exchange", { body: { code: code.body.code } });
    assert.equal(again.status, 401, show(again));
    const [device] = await q<{ tenant_id: string; branch_id: string; kiosk_type: string }>("select tenant_id, branch_id, kiosk_type from kiosk_devices where id = $1", [tablet!.device.id]);
    assert.deepEqual(device, { tenant_id: A.tenant, branch_id: A.x, kiosk_type: "reception" });
  });
  await check("the tablet reads its session and its branch, and today's board holds its own branch's check-ins only", async () => {
    const session = await call("GET", "/api/kiosk-reception/session", { headers: bearer(tablet!.token) });
    assert.equal(session.status, 200, show(session));
    assert.equal(session.body.branchId, A.x);
    assert.equal(session.body.kioskType, "reception");
    const branch = await call("GET", "/api/kiosk-reception/branch", { headers: bearer(tablet!.token) });
    assert.equal(branch.status, 200, show(branch));
    assert.equal(branch.body.id, A.x);
    for (const path of ["/api/core/checkins", "/api/kiosk-reception/checkins"]) {
      const board = await call("GET", path, { headers: bearer(tablet!.token) });
      assert.equal(board.status, 200, `${path}: ${show(board)}`);
      assert.deepEqual((board.body as { id: string }[]).map((c) => c.id).filter((id) => ours.has(id)), [cx], path);
    }
    const otherBranch = await call("GET", `/api/core/checkins?branchId=${A.y}`, { headers: bearer(tablet!.token) });
    assert.equal(otherBranch.status, 403, show(otherBranch));
  });
  await check("the reception action: the tablet moves its own branch's guest into the park; another branch's and another park group's guests are refused and unchanged", async () => {
    const res = await call("PATCH", `/api/core/checkins/${cx}/status`, { headers: bearer(tablet!.token), body: { status: "in_park" } });
    assert.equal(res.status, 200, show(res));
    assert.equal(await statusOf(cx), "in_park");
    const sameParkGroup = await call("PATCH", `/api/core/checkins/${cy}/status`, { headers: bearer(tablet!.token), body: { status: "in_park" } });
    assert.equal(sameParkGroup.status, 403, show(sameParkGroup));
    const elsewhere = await call("PATCH", `/api/core/checkins/${cz}/status`, { headers: bearer(tablet!.token), body: { status: "in_park" } });
    assert.equal(elsewhere.status, 404, show(elsewhere));
    assert.equal(await statusOf(cy), "registered");
    assert.equal(await statusOf(cz), "registered");
  });
  await check("no session, a made-up one, and a revoked tablet are refused", async () => {
    assert.equal((await call("GET", "/api/core/checkins")).status, 401);
    assert.equal((await call("GET", "/api/kiosk-reception/session", { headers: bearer("zz-not-a-token") })).status, 401);
    const revoked = await call("DELETE", `/api/kiosk-devices/${tablet!.device.id}/revoke`, { cookie: cookie.aLimited });
    assert.equal(revoked.status, 200, show(revoked));
    assert.equal((await call("GET", "/api/core/checkins", { headers: bearer(tablet!.token) })).status, 401);
    assert.equal((await call("PATCH", `/api/core/checkins/${cx}/status`, { headers: bearer(tablet!.token), body: { status: "checked_out" } })).status, 401);
    const refresh = await call("POST", "/api/kiosk/refresh-session", { body: { deviceId: tablet!.device.id, deviceSecret: tablet!.deviceSecret } });
    assert.equal(refresh.status, 401, show(refresh));
    assert.equal(await statusOf(cx), "in_park");
  });
  await check("fixed: a code for another park group's branch is not minted (404, the app's words); a device minted so before the fix reads none of that branch", async () => {
    const res = await call("POST", `/api/branches/${B.x}/kiosk-code`, { cookie: cookie.a });
    assert.equal(res.status, 404, show(res));
    assert.equal(res.body.message, "Branch not found");
    assert.equal(await count("select count(*) as n from kiosk_codes where branch_id = $1", [B.x]), 0);
    // A code row as the old route wrote it: A's park group, B's branch. The
    // pepper is the app's default where KIOSK_CODE_PEPPER is unset, as here.
    const code = `zz-${randomBytes(16).toString("hex")}`;
    await q("insert into kiosk_codes (tenant_id, branch_id, code_hash, expires_at) values ($1, $2, $3, now() + interval '10 minutes')", [
      A.tenant,
      B.x,
      sha256(code + (process.env.KIOSK_CODE_PEPPER || "default-kiosk-pepper-change-in-production")),
    ]);
    const old = await call("POST", "/api/kiosk/exchange", { body: { code } });
    assert.equal(old.status, 200, show(old));
    const branch = await call("GET", "/api/kiosk-reception/branch", { headers: bearer(old.body.token) });
    assert.equal(branch.status, 404, show(branch));
    for (const path of ["/api/core/checkins", "/api/kiosk-reception/checkins"]) {
      const board = await call("GET", path, { headers: bearer(old.body.token) });
      assert.equal(board.status, 200, `${path}: ${show(board)}`);
      assert.deepEqual(board.body, [], path);
    }
    const action = await call("PATCH", `/api/core/checkins/${cz}/status`, { headers: bearer(old.body.token), body: { status: "in_park" } });
    assert.equal(action.status, 404, show(action));
    assert.equal(await statusOf(cz), "registered");
  });
  await check("FINDING Q41: a manager limited to one branch can activate a reception tablet on another branch of their park group (the app has no branch rule there)", async () => {
    const res = await call("POST", `/api/branches/${A.y}/kiosk-code`, { cookie: cookie.aLimited });
    assert.equal(res.status, 200, show(res));
  });
  // Q46's record (round 5's review): the reach as it stands, the app's
  // default until the owner answers. Another park group's tablets are fenced
  // (section 4 of the plan); this is the same park group's other branch.
  await check("FINDING Q46 (reception tablets): a manager limited to one branch lists and revokes another branch's reception tablet in their park group (the app has no branch rule there)", async () => {
    const code = await call("POST", `/api/branches/${A.y}/kiosk-code`, { cookie: cookie.a });
    assert.equal(code.status, 200, show(code));
    const exchanged = await call("POST", "/api/kiosk/exchange", { body: { code: code.body.code } });
    assert.equal(exchanged.status, 200, show(exchanged));
    const yDevice = exchanged.body.device.id as string;
    const listed = await call("GET", `/api/branches/${A.y}/kiosk-devices`, { cookie: cookie.aLimited });
    assert.equal(listed.status, 200, show(listed));
    assert.ok((listed.body as { id: string }[]).some((d) => d.id === yDevice), JSON.stringify(listed.body));
    const revoked = await call("DELETE", `/api/kiosk-devices/${yDevice}/revoke`, { cookie: cookie.aLimited });
    assert.equal(revoked.status, 200, show(revoked));
    assert.deepEqual(await q("select is_active from kiosk_devices where id = $1", [yDevice]), [{ is_active: false }]);
  });

  // ── 6. Restricted-branch proof ──────────────────────────────────────────────
  console.log("6. a manager limited to branch X (the app's own branch rules; FINDINGs pinned as they stand):");
  const empX = await employee(A.tenant, A.x, "leave-x");
  const empY = await employee(A.tenant, A.y, "leave-y");
  const timeOff = async (employeeId: string, branch: string, d: string) => {
    const id = randomUUID();
    await q(
      `insert into employee_time_off (id, tenant_id, employee_id, branch_id, type, start_date, end_date, created_by)
       values ($1, $2, $3, $4, 'ANNUAL', $5::date, $5::date, $6)`,
      [id, A.tenant, employeeId, branch, d, A.admin.id],
    );
    return id;
  };
  const toX = await timeOff(empX, A.x, day(100));
  const toY = await timeOff(empY, A.y, day(100));

  await check("leave: the list holds X's days off only, and Y's are refused to read, add, change or remove; X's work", async () => {
    const list = await call("GET", "/api/time-off", { cookie: cookie.aLimited });
    assert.equal(list.status, 200, show(list));
    const ids = (list.body as { id: string }[]).map((t) => t.id);
    assert.ok(ids.includes(toX) && !ids.includes(toY), JSON.stringify(ids));
    assert.equal((await call("GET", `/api/time-off?branchId=${A.y}`, { cookie: cookie.aLimited })).status, 403);
    const addY = await call("POST", "/api/time-off", { cookie: cookie.aLimited, body: { employeeId: empY, branchId: A.y, timeOffType: "ANNUAL", startDate: day(101), endDate: day(101) } });
    assert.equal(addY.status, 403, show(addY));
    assert.equal((await call("PATCH", `/api/time-off/${toY}`, { cookie: cookie.aLimited, body: { notes: "ZZ" } })).status, 403);
    assert.equal((await call("DELETE", `/api/time-off/${toY}`, { cookie: cookie.aLimited })).status, 403);
    assert.equal(await count("select count(*) as n from employee_time_off where id = $1 and note is null", [toY]), 1);
    const addX = await call("POST", "/api/time-off", { cookie: cookie.aLimited, body: { employeeId: empX, branchId: A.x, timeOffType: "ANNUAL", startDate: day(101), endDate: day(101) } });
    assert.equal(addX.status, 201, show(addX));
    assert.equal((await call("PATCH", `/api/time-off/${toX}`, { cookie: cookie.aLimited, body: { notes: "ZZ" } })).status, 200);
    assert.equal((await call("GET", `/api/leave-balances?branchId=${A.y}`, { cookie: cookie.aLimited })).status, 403);
    assert.equal((await call("GET", `/api/leave-balances?branchId=${A.x}`, { cookie: cookie.aLimited })).status, 200);
    assert.equal((await call("GET", `/api/employees/${empY}/leave-balance`, { cookie: cookie.aLimited })).status, 403);
  });
  await check("FINDING Q40 (leave): sick-leave balances answer branch Y, and the leave-policy and per-employee balance reads refuse even branch X (they read a field the user does not carry)", async () => {
    assert.equal((await call("GET", `/api/sick-leave-balances?branchId=${A.y}`, { cookie: cookie.aLimited })).status, 200);
    assert.equal((await call("GET", `/api/employees/${empY}/sick-leave-balance`, { cookie: cookie.aLimited })).status, 200);
    assert.equal((await call("GET", `/api/leave-policies?branchId=${A.x}`, { cookie: cookie.aLimited })).status, 403);
    assert.equal((await call("GET", `/api/leave-balances/employee/${empX}`, { cookie: cookie.aLimited })).status, 403);
  });

  const yRota = await rota(A, A.y);
  const bRota = await rota(B, B.x);
  await check("scheduling: the rota keeps a limited manager to their branch, and the legacy shift list's coverage read does when a branch is named (with none, the app has no branch rule: Q39)", async () => {
    const window = `from=${day(0)}&to=${day(6)}`;
    assert.equal((await call("GET", `/api/rota?scope=branch&branchId=${A.y}&${window}`, { cookie: cookie.aLimited })).status, 403);
    assert.equal((await call("GET", `/api/rota?scope=branch&branchId=${A.x}&${window}`, { cookie: cookie.aLimited })).status, 200);
    assert.equal((await call("GET", `/api/shifts-needing-coverage?branchId=${A.y}`, { cookie: cookie.aLimited })).status, 403);
  });
  await check("FINDING Q39 (scheduling): the week plan, shift groups and rows answer branch Y — and another park group's branch — to a limited manager (no branch or park-group rule in /api/schedule)", async () => {
    const weekY = await call("GET", `/api/schedule/week?branchId=${A.y}&weekStartDate=${day(0)}`, { cookie: cookie.aLimited });
    assert.equal(weekY.status, 200, show(weekY));
    assert.equal(weekY.body?.branchId, A.y);
    assert.ok((weekY.body.shiftRows as { id: string }[]).length > 0, "with its rows");
    const groupsElsewhere = await call("GET", `/api/schedule/shift-groups?branchId=${B.x}`, { cookie: cookie.aLimited });
    assert.equal(groupsElsewhere.status, 200, show(groupsElsewhere));
    assert.ok((groupsElsewhere.body as { id: string }[]).some((g) => g.id === bRota.group));
    const weekElsewhere = await call("GET", `/api/schedule/week?branchId=${B.x}&weekStartDate=${day(0)}`, { cookie: cookie.aLimited });
    assert.equal(weekElsewhere.status, 200, show(weekElsewhere));
    assert.equal(weekElsewhere.body?.id, bRota.plan);
    assert.equal(weekElsewhere.body?.branchId, B.x);
    const rowY = await call("POST", "/api/schedule/shift-rows", {
      cookie: cookie.aLimited,
      body: { branchId: A.y, startTime: "08:00", endTime: "12:00", label: "ZZ TEST finding", shiftGroupId: yRota.group },
    });
    assert.equal(rowY.status, 201, show(rowY));
    // And a write into another park group: the row is made in B's branch, as B's.
    const rowElsewhere = await call("POST", "/api/schedule/shift-rows", {
      cookie: cookie.aLimited,
      body: { branchId: B.x, startTime: "08:00", endTime: "12:00", label: "ZZ TEST finding", shiftGroupId: bRota.group },
    });
    assert.equal(rowElsewhere.status, 201, show(rowElsewhere));
    assert.equal(rowElsewhere.body.tenantId, B.tenant);
  });

  const template = async (branch: string, label: string) => {
    const id = randomUUID();
    await q("insert into checklist_templates (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [id, A.tenant, branch, `ZZ TEST r5 ${label} ${run}`]);
    return id;
  };
  const tplX = await template(A.x, "x");
  const tplY = await template(A.y, "y");
  await check("checklists: Y's templates are refused to list, read, change, remove or start, and a template for Y is not made; X's work", async () => {
    assert.equal((await call("GET", `/api/checklists/templates?branchId=${A.y}`, { cookie: cookie.aLimited })).status, 403);
    const listed = await call("GET", "/api/checklists/templates", { cookie: cookie.aLimited });
    assert.equal(listed.status, 200, show(listed));
    const ids = (listed.body as { id: string }[]).map((t) => t.id);
    assert.ok(ids.includes(tplX) && !ids.includes(tplY), JSON.stringify(ids));
    assert.equal((await call("GET", `/api/checklists/templates/${tplY}`, { cookie: cookie.aLimited })).status, 403);
    assert.equal((await call("PATCH", `/api/checklists/templates/${tplY}`, { cookie: cookie.aLimited, body: { name: "ZZ changed" } })).status, 403);
    assert.equal((await call("DELETE", `/api/checklists/templates/${tplY}`, { cookie: cookie.aLimited })).status, 403);
    assert.equal((await call("POST", "/api/checklist-runs/start", { cookie: cookie.aLimited, body: { templateId: tplY } })).status, 403);
    const makeY = await call("POST", "/api/checklists/templates", { cookie: cookie.aLimited, body: { name: `ZZ TEST r5 made ${run}`, branchIds: [A.y] } });
    assert.equal(makeY.status, 403, show(makeY));
    assert.equal(await count("select count(*) as n from checklist_templates where branch_id = $1 and name = $2", [A.y, `ZZ TEST r5 made ${run}`]), 0);
    assert.equal(await count("select count(*) as n from checklist_templates where id = $1 and name like 'ZZ TEST r5 y%'", [tplY]), 1);
    assert.equal((await call("GET", `/api/checklists/templates/${tplX}`, { cookie: cookie.aLimited })).status, 200);
    const started = await call("POST", "/api/checklist-runs/start", { cookie: cookie.aLimited, body: { templateId: tplX } });
    assert.ok([200, 201].includes(started.status), show(started));
  });
  // Q46's record (round 5's review): the reach as it stands, the app's
  // default until the owner answers.
  await check("FINDING Q46 (checklists): a manager limited to X reads Y's checklist history, though Y's template itself is refused them (the app has no branch rule on the history)", async () => {
    const runY = randomUUID();
    await q("insert into checklist_runs (id, tenant_id, template_id, branch_id, status, completed_at) values ($1, $2, $3, $4, 'completed', now())", [
      runY,
      A.tenant,
      tplY,
      A.y,
    ]);
    assert.equal((await call("GET", `/api/checklists/templates/${tplY}`, { cookie: cookie.aLimited })).status, 403);
    const history = await call("GET", `/api/checklists/checker-history/${tplY}`, { cookie: cookie.aLimited });
    assert.equal(history.status, 200, show(history));
    assert.deepEqual((history.body.runs as { id: string; branchId: string }[]).map((r) => [r.id, r.branchId]), [[runY, A.y]]);
  });

  await check("announcements: an audience outside X is refused in words; Y's announcement is not listed and is a 404 to change or remove; X's work", async () => {
    const window = { startDate: new Date(Date.now() - 86_400_000).toISOString(), endDate: new Date(Date.now() + 7 * 86_400_000).toISOString() };
    const toY = await call("POST", "/api/announcements", { cookie: cookie.aLimited, body: { title: "ZZ Y", body: "ZZ", ...window, showToEveryone: false, branchIds: [A.y] } });
    assert.equal(toY.status, 403, show(toY));
    assert.equal(toY.body.message, "Announcement audience is outside your branches");
    const everyone = await call("POST", "/api/announcements", { cookie: cookie.aLimited, body: { title: "ZZ all", body: "ZZ", ...window, showToEveryone: true } });
    assert.equal(everyone.status, 403, `the app's rule: only an every-branch manager speaks to everyone — ${show(everyone)}`);
    const adminY = await call("POST", "/api/announcements", { cookie: cookie.a, body: { title: `ZZ Y ${run}`, body: "ZZ", ...window, showToEveryone: false, branchIds: [A.y] } });
    assert.equal(adminY.status, 200, show(adminY));
    const mineX = await call("POST", "/api/announcements", { cookie: cookie.aLimited, body: { title: `ZZ X ${run}`, body: "ZZ", ...window, showToEveryone: false, branchIds: [A.x] } });
    assert.equal(mineX.status, 200, show(mineX));
    const list = await call("GET", "/api/announcements", { cookie: cookie.aLimited });
    const ids = (list.body as { id: string }[]).map((a) => a.id);
    assert.ok(ids.includes(mineX.body.id) && !ids.includes(adminY.body.id), JSON.stringify(ids));
    assert.equal((await call("PATCH", `/api/announcements/${adminY.body.id}`, { cookie: cookie.aLimited, body: { title: "ZZ changed" } })).status, 404);
    assert.equal((await call("DELETE", `/api/announcements/${adminY.body.id}`, { cookie: cookie.aLimited })).status, 404);
    assert.equal(await count("select count(*) as n from announcements where id = $1 and title = $2", [adminY.body.id, `ZZ Y ${run}`]), 1);
    assert.equal((await call("GET", `/api/announcements/active?branchId=${A.y}`, { cookie: cookie.aLimited })).status, 403);
    const active = await call("GET", "/api/announcements/active", { cookie: cookie.aLimited });
    const shown = (active.body as { id: string }[]).map((a) => a.id);
    assert.ok(shown.includes(mineX.body.id) && !shown.includes(adminY.body.id), JSON.stringify(shown));
    assert.equal((await call("PATCH", `/api/announcements/${mineX.body.id}`, { cookie: cookie.aLimited, body: { title: `ZZ X2 ${run}` } })).status, 200);
  });

  await check("notifications: each person reads and marks their own only (they carry no branch; the rule is the recipient)", async () => {
    const note = async (recipient: string, tenant: string) => {
      const id = randomUUID();
      await q(
        "insert into notifications (id, tenant_id, recipient_user_id, type, title, body) values ($1, $2, $3, 'announcement', $4, 'ZZ')",
        [id, tenant, recipient, `ZZ TEST r5 ${run}`],
      );
      return id;
    };
    const mine = await note(A.limited.id, A.tenant);
    const admins = await note(A.admin.id, A.tenant);
    const list = await call("GET", "/api/notifications", { cookie: cookie.aLimited });
    assert.deepEqual((list.body as { id: string }[]).map((n) => n.id), [mine]);
    assert.deepEqual((await call("GET", "/api/notifications/unread-count", { cookie: cookie.aLimited })).body, { count: 1 });
    assert.equal((await call("PATCH", `/api/notifications/${admins}/read`, { cookie: cookie.aLimited })).status, 404);
    assert.equal((await call("POST", "/api/notifications/mark-all-read", { cookie: cookie.aLimited })).status, 200);
    const read = await q<{ id: string; is_read: boolean }>("select id, is_read from notifications where id = any($1) order by id", [[mine, admins]]);
    assert.deepEqual(Object.fromEntries(read.map((r) => [r.id, r.is_read])), { [mine]: true, [admins]: false });
  });

  console.log(`attendance.check: ${checks} checks passed`);
} catch (err) {
  console.error("attendance.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await q(`drop trigger if exists ${CONCURRENT} on employee_time_off`).catch(() => undefined);
  await q(`drop function if exists ${CONCURRENT}()`).catch(() => undefined);
  await q(`drop table if exists ${CONCURRENT}`).catch(() => undefined);
  await pool.end();
}
