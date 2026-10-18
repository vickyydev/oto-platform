// seed: its own — two park groups' worth of ZZ TEST rows, made here (the
// slug-`default` park group only when the database has none). Not a
// Playwright file (the suite collects *.spec.ts and *.test.ts; this is
// neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated.
//
// SCRUM-560 (the October Replit port, R3) — flexible leave types, over HTTP
// against the routes as registered and in the database migration 0018 made:
//
//   1. The catalogue per park group: two park groups get their own seven
//      built-in types, each from ITS OWN settings, company-wide Days Off
//      policy and company-wide sick policy (upstream's seed read any park
//      group's); a second start makes nothing; nothing crosses.
//   2. The opening snapshot, once: a person made before the catalogue gets one
//      frozen balance per accruing built-in type — the amounts the app showed
//      before — and a rerun adds nothing; a later hire gets none.
//   3. The balance engine: YEARLY (waiting months, with and without proration,
//      usage counted) and WORKDAYS (every 5 days worked earns 2), and an
//      opening carried forward with only newer usage charged.
//   4. Overrides: the park group's own employee and type only; another park
//      group's is the 404; a branch out of reach is the 403.
//   5. Time off: the type is one of the park group's ACTIVE codes, stored by
//      its code; anything else is the 400.
//   6. Leave policies: the combined lookup answers a branch policy's id, the
//      Days Off type's id and a pre-0018 company-wide policy's id; another
//      park group's is the 404; a manager limited to X reads X and not Y.
//   7. The settings keys and the sick-leave policy read and save the types.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/leave-types.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("leave-types.check: DATABASE_URL is not set");
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

// The database's own calendar: the snapshot reads `current_date`.
const [{ cy, cm }] = await q<{ cy: number; cm: number }>(
  "select extract(year from current_date)::int as cy, extract(month from current_date)::int as cm",
);
const ly = cy - 1;

// ─── Two park groups of our own ──────────────────────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");

interface ParkGroup {
  tenant: string;
  x: string;
  y: string;
  admin: { id: string; email: string };
  /** A manager limited to branch X. */
  limited: { id: string; email: string };
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

async function employee(g: ParkGroup, branch: string, label: string, startDate: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, start_date)
     values ($1, $2, $3, $4, 'ZZ', $5, 'active', $6)`,
    [id, g.tenant, branch, `ZZ TEST ${run} ${label}`, `zz-lt-${label}-${id.slice(0, 8)}@example.com`, startDate],
  );
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST lt ${label} ${run}`, `zz-lt-${label}-${run}`]);
  const x = randomUUID();
  const y = randomUUID();
  for (const [id, suffix] of [[x, "x"], [y, "y"]] as const) {
    await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
      id,
      tenant,
      `ZZ TEST lt ${label} ${suffix} ${run}`,
    ]);
  }
  const adminEmail = `zz-lt-${label}-admin-${run}@example.com`;
  const limitedEmail = `zz-lt-${label}-limited-${run}@example.com`;
  return {
    tenant,
    x,
    y,
    admin: { id: await user(tenant, "admin", adminEmail, null), email: adminEmail },
    limited: { id: await user(tenant, "manager", limitedEmail, x), email: limitedEmail },
  };
}

const A = await parkGroup("a");
const B = await parkGroup("b");

/** A week plan, a shift group and a row in a branch, for assignments. */
async function rota(g: ParkGroup, branch: string) {
  const plan = randomUUID();
  await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [plan, g.tenant, branch, day(0)]);
  const group = randomUUID();
  await q("insert into shift_groups (id, tenant_id, branch_id, name) values ($1, $2, $3, $4)", [group, g.tenant, branch, `ZZ TEST lt ${run}`]);
  const row = randomUUID();
  await q(
    `insert into schedule_shift_rows (id, tenant_id, branch_id, shift_group_id, week_plan_id, start_time, end_time, label)
     values ($1, $2, $3, $4, $5, '09:00', '17:00', 'ZZ TEST')`,
    [row, g.tenant, branch, group, plan],
  );
  return { plan, row };
}
async function worked(g: ParkGroup, r: { plan: string; row: string }, employeeId: string, dates: string[]) {
  for (const date of dates) {
    await q(
      `insert into schedule_assignments (id, tenant_id, week_plan_id, shift_row_id, shift_date, employee_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), g.tenant, r.plan, r.row, date, employeeId],
    );
  }
}
async function timeOff(g: ParkGroup, branch: string, employeeId: string, type: string, start: string, end: string) {
  await q(
    `insert into employee_time_off (tenant_id, employee_id, branch_id, type, start_date, end_date, created_by)
     values ($1, $2, $3, $4, $5::timestamp, $6::timestamp, $7)`,
    [g.tenant, employeeId, branch, type, start, end, g.admin.id],
  );
}

// What each park group read before 0018, each its OWN: settings rows, a
// company-wide Days Off policy and a company-wide sick-leave policy.
const legacy = {
  A: { annual: 10, wait: 3, business: 5, sick: 12, required: 4, earned: 1 },
  B: { annual: 14, wait: 0, business: 2, sick: 20, required: 6, earned: 3 },
} as const;
const legacyCompanyWide: Record<"A" | "B", string> = { A: "", B: "" };
for (const [name, g] of [["A", A], ["B", B]] as const) {
  const v = legacy[name];
  for (const [key, value] of [["annual_leave_total_days", v.annual], ["annual_leave_waiting_months", v.wait], ["business_days_total", v.business]] as const) {
    await q("insert into settings (tenant_id, key, value) values ($1, $2, $3)", [g.tenant, key, String(value)]);
  }
  legacyCompanyWide[name] = (await q<{ id: string }>(
    `insert into leave_policies (tenant_id, branch_id, name, days_worked_required, days_off_earned, effective_from, is_active)
     values ($1, null, $2, $3, $4, now() - interval '10 days', true) returning id`,
    [g.tenant, `ZZ TEST lt ${name} company-wide ${run}`, v.required, v.earned],
  ))[0]!.id;
  await q("insert into sick_leave_policies (tenant_id, branch_id, annual_sick_leave_days, pro_rate_by_start_date) values ($1, null, $2, true)", [
    g.tenant,
    v.sick,
  ]);
}

// People made BEFORE the catalogue: A's with days worked and leave taken.
const rotaA = await rota(A, A.x);
const before = await employee(A, A.x, "before", "2020-01-01");
await worked(A, rotaA, before, Array.from({ length: 9 }, (_, i) => day(-40 - i)));
await timeOff(A, A.x, before, "CHANGE_DAY_OFF", `${ly}-06-01`, `${ly}-06-01`);
await timeOff(A, A.x, before, "ANNUAL", `${cy}-01-05`, `${cy}-01-06`);
await timeOff(A, A.x, before, "SICK", `${cy}-01-08`, `${cy}-01-08`);
const beforeB = await employee(B, B.x, "before-b", "2020-01-01");

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

type TypeRow = { id: string; code: string; name: string; isActive: boolean; accrualMethod: string; annualDays: number; waitingMonths: number; prorateByStartDate: boolean; daysWorkedRequired: number; daysOffEarned: number };
type Balance = { leaveTypeId: string; code: string; earned: number; used: number; balance: number; canClaim: boolean };
const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} is not ${expected}`);

try {
  ORIGIN = await serve();
  const cookie = {
    a: await signIn(A.admin.email),
    aLimited: await signIn(A.limited.email),
    b: await signIn(B.admin.email),
  };
  const typesOf = async (c: string) => {
    const res = await call("GET", "/api/leave-types", { cookie: c });
    assert.equal(res.status, 200, show(res));
    return res.body as TypeRow[];
  };
  const balancesOf = async (c: string, employeeId: string, year?: number) => {
    const res = await call("GET", `/api/employees/${employeeId}/leave-balances-dynamic${year ? `?year=${year}` : ""}`, { cookie: c });
    assert.equal(res.status, 200, show(res));
    return res.body.balances as Balance[];
  };
  const byCode = <T extends { code: string }>(rows: T[], code: string) => {
    const row = rows.find((r) => r.code === code);
    assert.ok(row, `no ${code} in ${JSON.stringify(rows.map((r) => r.code))}`);
    return row!;
  };

  // ── 1. The catalogue per park group ─────────────────────────────────────────
  console.log("1. each park group's own catalogue, from its own numbers:");
  let typesA: TypeRow[] = [];
  let typesB: TypeRow[] = [];
  await check("A's and B's first reads make seven built-in types each, every value from the park group's own settings and policies", async () => {
    assert.equal(await count("select count(*) as n from leave_types where tenant_id = any($1)", [[A.tenant, B.tenant]]), 0);
    typesA = await typesOf(cookie.a);
    typesB = await typesOf(cookie.b);
    for (const [types, v] of [[typesA, legacy.A], [typesB, legacy.B]] as const) {
      assert.deepEqual(types.map((t) => t.code).sort(), ["ANNUAL", "BUSINESS", "CHANGE_DAY_OFF", "OTHER", "SICK", "TRAINING", "UNPAID"]);
      assert.deepEqual([byCode(types, "ANNUAL").annualDays, byCode(types, "ANNUAL").waitingMonths], [v.annual, v.wait]);
      assert.equal(byCode(types, "BUSINESS").annualDays, v.business);
      assert.deepEqual([byCode(types, "SICK").annualDays, byCode(types, "SICK").prorateByStartDate], [v.sick, true]);
      assert.deepEqual(
        [byCode(types, "CHANGE_DAY_OFF").accrualMethod, byCode(types, "CHANGE_DAY_OFF").daysWorkedRequired, byCode(types, "CHANGE_DAY_OFF").daysOffEarned],
        ["WORKDAYS", v.required, v.earned],
      );
    }
  });

  await check("no leak: the two catalogues share no row, each row is its own park group's, and a second start (HTTP and the function) makes nothing", async () => {
    const idsA = new Set(typesA.map((t) => t.id));
    assert.ok(typesB.every((t) => !idsA.has(t.id)));
    assert.equal(await count("select count(*) as n from leave_types where tenant_id = $1", [A.tenant]), 7);
    assert.equal(await count("select count(*) as n from leave_types where tenant_id = $1", [B.tenant]), 7);
    await typesOf(cookie.a);
    const [{ made }] = await q<{ made: number }>("select seed_tenant_leave_types($1) as made", [A.tenant]);
    assert.equal(made, 0);
    assert.equal(await count("select count(*) as n from leave_types where tenant_id = $1", [A.tenant]), 7);
    // Another park group's type is not reachable by id.
    const foreign = await call("PATCH", `/api/leave-types/${byCode(typesA, "ANNUAL").id}`, { cookie: cookie.b, body: { name: "ZZ hijack" } });
    assert.equal(foreign.status, 404, show(foreign));
    assert.equal(byCode(await typesOf(cookie.a), "ANNUAL").name, "Annual Leave");
  });

  // ── 2. The opening snapshot ─────────────────────────────────────────────────
  console.log("2. the opening snapshot, once:");
  type Opening = { code: string; opening_balance: number; worked_days_at_snapshot: number; tenant_id: string };
  const openingsOf = (employeeId: string) =>
    q<Opening>(
      `select lt.code, o.opening_balance, o.worked_days_at_snapshot, o.tenant_id
         from employee_leave_balance_openings o join leave_types lt on lt.id = o.leave_type_id
        where o.employee_id = $1 order by lt.code`,
      [employeeId],
    );
  await check("a person made before the catalogue holds one opening per accruing built-in type, at the balance the app showed before", async () => {
    const months = cm - 1; // full months this year from 1 January (started 2020)
    const expected = {
      ANNUAL: Math.floor((months / 12) * legacy.A.annual) - 2,
      BUSINESS: Math.floor((months / 12) * legacy.A.business),
      CHANGE_DAY_OFF: Math.floor(9 / legacy.A.required) * legacy.A.earned - 1,
      SICK: legacy.A.sick - 1,
    };
    const rows = await openingsOf(before);
    assert.deepEqual(rows.map((r) => r.code), ["ANNUAL", "BUSINESS", "CHANGE_DAY_OFF", "SICK"]);
    for (const r of rows) {
      assert.equal(r.tenant_id, A.tenant);
      assert.equal(r.opening_balance, expected[r.code as keyof typeof expected], r.code);
      assert.equal(r.worked_days_at_snapshot, r.code === "CHANGE_DAY_OFF" ? 9 : 0, r.code);
    }
    const bRows = await openingsOf(beforeB);
    assert.deepEqual(
      Object.fromEntries(bRows.map((r) => [r.code, r.opening_balance])),
      {
        ANNUAL: Math.floor((months / 12) * legacy.B.annual),
        BUSINESS: Math.floor((months / 12) * legacy.B.business),
        CHANGE_DAY_OFF: 0,
        SICK: legacy.B.sick,
      },
    );
    assert.ok(bRows.every((r) => r.tenant_id === B.tenant));
  });

  let after = "";
  await check("once only: a rerun adds nothing, and a person hired after the catalogue gets no opening", async () => {
    const total = () => count("select count(*) as n from employee_leave_balance_openings where tenant_id = any($1)", [[A.tenant, B.tenant]]);
    const n = await total();
    assert.equal(n, 8);
    const [{ made }] = await q<{ made: number }>("select snapshot_leave_balance_openings($1) as made", [A.tenant]);
    assert.equal(made, 0);
    after = await employee(A, A.x, "after", `${ly}-03-10`);
    await typesOf(cookie.a);
    await balancesOf(cookie.a, after);
    assert.equal((await q<{ made: number }>("select snapshot_leave_balance_openings($1) as made", [A.tenant]))[0]!.made, 0);
    assert.deepEqual(await openingsOf(after), []);
    assert.equal(await total(), n);
    assert.equal(
      await count(
        `select count(*) as n from employee_leave_balance_openings o
           join employees e on e.id = o.employee_id join leave_types lt on lt.id = o.leave_type_id
          where o.tenant_id <> e.tenant_id or o.tenant_id <> lt.tenant_id`,
      ),
      0,
    );
  });

  // ── 3. The balance engine ───────────────────────────────────────────────────
  console.log("3. the balance engine:");
  const created = async (body: Record<string, unknown>) => {
    const res = await call("POST", "/api/leave-types", { cookie: cookie.a, body });
    assert.equal(res.status, 201, show(res));
    return res.body as TypeRow;
  };
  const yearly = await created({ name: `ZZ Yearly ${run}`, code: `ZZ_YEARLY_${RUN}`, accrualMethod: "YEARLY", annualDays: 12, waitingMonths: 6, prorateByStartDate: false });
  const prorated = await created({ name: `ZZ Prorated ${run}`, code: `ZZ_PRORATED_${RUN}`, accrualMethod: "YEARLY", annualDays: 12, waitingMonths: 6, prorateByStartDate: true });
  const workdays = await created({ name: `ZZ Workdays ${run}`, code: `ZZ_WORK_${RUN}`, accrualMethod: "WORKDAYS", daysWorkedRequired: 5, daysOffEarned: 2 });

  await check("YEARLY with six waiting months: a start on 10 March earns from 10 September — 3 whole months of 12 days a year, 3.67 prorated; 2 days taken leave 1 and 1.67", async () => {
    const booked = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: after, branchId: A.x, timeOffType: yearly.code.toLowerCase(), startDate: `${ly}-11-02`, endDate: `${ly}-11-03` },
    });
    assert.equal(booked.status, 201, show(booked));
    assert.equal(booked.body.type, yearly.code, "stored by the type's code");
    const bookedProrated = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: after, branchId: A.x, timeOffType: prorated.code, startDate: `${ly}-12-01`, endDate: `${ly}-12-02` },
    });
    assert.equal(bookedProrated.status, 201, show(bookedProrated));
    const last = await balancesOf(cookie.a, after, ly);
    const y = byCode(last, yearly.code);
    assert.deepEqual([y.earned, y.used, y.balance, y.canClaim], [3, 2, 1, true]);
    const p = byCode(last, prorated.code);
    near(p.earned, 3.67, "prorated earned");
    assert.equal(p.used, 2);
    near(p.balance, 1.67, "prorated balance");
  });

  await check("YEARLY still in its waiting months: nothing earned and nothing claimable", async () => {
    const recent = await employee(A, A.x, "recent", day(-60));
    const y = byCode(await balancesOf(cookie.a, recent), yearly.code);
    assert.deepEqual([y.earned, y.canClaim], [0, false]);
  });

  let steady = "";
  await check("WORKDAYS 5 -> 2: eleven days worked earn 4; one day taken leaves 3", async () => {
    steady = await employee(A, A.x, "steady", "2020-01-01");
    await worked(A, rotaA, steady, Array.from({ length: 11 }, (_, i) => day(-1 - i)));
    const booked = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: steady, branchId: A.x, timeOffType: workdays.code, startDate: day(-20), endDate: day(-20) },
    });
    assert.equal(booked.status, 201, show(booked));
    const w = byCode(await balancesOf(cookie.a, steady), workdays.code);
    assert.deepEqual([w.earned, w.used, w.balance, w.canClaim], [4, 1, 3, true]);
  });

  await check("an opening is carried forward: the frozen Days Off balance stands, and only leave booked after it is charged", async () => {
    const opening = (await openingsOf(before)).find((r) => r.code === "CHANGE_DAY_OFF")!.opening_balance;
    const first = byCode(await balancesOf(cookie.a, before), "CHANGE_DAY_OFF");
    assert.deepEqual([first.earned, first.used, first.balance], [opening, 0, opening]);
    const booked = await call("POST", "/api/time-off", {
      cookie: cookie.a,
      body: { employeeId: before, branchId: A.x, timeOffType: "CHANGE_DAY_OFF", startDate: day(-25), endDate: day(-25) },
    });
    assert.equal(booked.status, 201, show(booked));
    const later = byCode(await balancesOf(cookie.a, before), "CHANGE_DAY_OFF");
    assert.deepEqual([later.earned, later.used, later.balance], [opening, 1, opening - 1]);
    // The Days Off read the rota uses agrees.
    const legacyRead = await call("GET", `/api/employees/${before}/leave-balance`, { cookie: cookie.a });
    assert.equal(legacyRead.status, 200, show(legacyRead));
    assert.deepEqual([legacyRead.body.balance, legacyRead.body.policyName], [opening - 1, "Days Off"]);
  });

  // ── 4. Overrides ────────────────────────────────────────────────────────────
  console.log("4. overrides, in the park group only:");
  await check("an admin overrides A's own type for A's own employee, and the engine reads it (24 days a year doubles the earning)", async () => {
    const put = await call("PUT", `/api/employees/${after}/leave-overrides/${yearly.id}`, { cookie: cookie.a, body: { annualDays: 24 } });
    assert.equal(put.status, 200, show(put));
    const list = await call("GET", `/api/employees/${after}/leave-overrides`, { cookie: cookie.a });
    assert.deepEqual(list.body, [{ leaveTypeId: yearly.id, annualDays: 24, accrualStartDate: null, waitingMonths: null }]);
    assert.equal(byCode(await balancesOf(cookie.a, after, ly), yearly.code).earned, 6);
  });

  await check("another park group's employee or type is the 404, and nothing is written; a branch out of reach is the 403; a manager cannot write", async () => {
    const bOwn = await employee(B, B.x, "b-own", "2020-01-01");
    const typesBNow = await typesOf(cookie.b);
    const overrides = () => count("select count(*) as n from employee_leave_overrides where tenant_id = any($1)", [[A.tenant, B.tenant]]);
    const n = await overrides();
    for (const [path, body] of [
      [`/api/employees/${after}/leave-overrides/${yearly.id}`, { annualDays: 1 }],
      [`/api/employees/${after}/leave-overrides/${byCode(typesBNow, "ANNUAL").id}`, { annualDays: 1 }],
      [`/api/employees/${bOwn}/leave-overrides/${yearly.id}`, { annualDays: 1 }],
    ] as const) {
      const res = await call("PUT", path, { cookie: cookie.b, body });
      assert.equal(res.status, 404, `${path}: ${show(res)}`);
    }
    assert.equal((await call("GET", `/api/employees/${after}/leave-overrides`, { cookie: cookie.b })).status, 404);
    assert.equal((await call("GET", `/api/employees/${after}/leave-balances-dynamic`, { cookie: cookie.b })).status, 404);
    assert.equal((await call("DELETE", `/api/employees/${after}/leave-overrides/${yearly.id}`, { cookie: cookie.b })).status, 404);
    assert.equal(await overrides(), n);
    // A's manager limited to X: reads X's people, not Y's; writes nothing.
    const onY = await employee(A, A.y, "on-y", "2020-01-01");
    assert.equal((await call("GET", `/api/employees/${after}/leave-overrides`, { cookie: cookie.aLimited })).status, 200);
    assert.equal((await call("GET", `/api/employees/${onY}/leave-overrides`, { cookie: cookie.aLimited })).status, 403);
    assert.equal((await call("GET", `/api/employees/${onY}/leave-balances-dynamic`, { cookie: cookie.aLimited })).status, 403);
    assert.equal((await call("PUT", `/api/employees/${after}/leave-overrides/${yearly.id}`, { cookie: cookie.aLimited, body: { annualDays: 1 } })).status, 403);
    assert.equal(
      await count(
        `select count(*) as n from employee_leave_overrides o
           join employees e on e.id = o.employee_id join leave_types lt on lt.id = o.leave_type_id
          where o.tenant_id <> e.tenant_id or o.tenant_id <> lt.tenant_id`,
      ),
      0,
    );
    const removed = await call("DELETE", `/api/employees/${after}/leave-overrides/${yearly.id}`, { cookie: cookie.a });
    assert.equal(removed.status, 204, show(removed));
    assert.equal(await overrides(), n - 1);
  });

  await check("a duplicate code is the 409, whatever its case; a manager cannot make a type", async () => {
    const dup = await call("POST", "/api/leave-types", { cookie: cookie.a, body: { name: "ZZ again", code: "annual" } });
    assert.equal(dup.status, 409, show(dup));
    assert.equal((await call("POST", "/api/leave-types", { cookie: cookie.aLimited, body: { name: `ZZ manager ${run}` } })).status, 403);
    // B may use a code A already has: catalogues are per park group.
    const bSame = await call("POST", "/api/leave-types", { cookie: cookie.b, body: { name: "ZZ B", code: yearly.code } });
    assert.equal(bSame.status, 201, show(bSame));
  });

  // ── 5. Time off against active codes ───────────────────────────────────────
  console.log("5. time off takes the park group's active codes:");
  await check("an unknown code, a switched-off code and another park group's own code are each the 400 and save nothing; switched back on, it books", async () => {
    const onlyB = await call("POST", "/api/leave-types", { cookie: cookie.b, body: { name: `ZZ only B ${run}`, code: `ZZ_ONLYB_${RUN}` } });
    assert.equal(onlyB.status, 201, show(onlyB));
    const rows = () => count("select count(*) as n from employee_time_off where employee_id = $1", [steady]);
    const n = await rows();
    const book = (type: string, d: string) =>
      call("POST", "/api/time-off", { cookie: cookie.a, body: { employeeId: steady, branchId: A.x, timeOffType: type, startDate: d, endDate: d } });
    for (const type of ["NOPE", `ZZ_ONLYB_${RUN}`]) {
      const res = await book(type, day(10));
      assert.equal(res.status, 400, `${type}: ${show(res)}`);
      assert.deepEqual(res.body, { message: "Unknown or inactive leave type" });
    }
    assert.equal((await call("PATCH", `/api/leave-types/${workdays.id}`, { cookie: cookie.a, body: { isActive: false } })).status, 200);
    assert.equal((await book(workdays.code, day(11))).status, 400);
    assert.equal(await rows(), n);
    assert.equal((await call("PATCH", `/api/leave-types/${workdays.id}`, { cookie: cookie.a, body: { isActive: true } })).status, 200);
    const ok = await book(workdays.code, day(12));
    assert.equal(ok.status, 201, show(ok));
    // A change of type is held to the same list.
    const moved = await call("PATCH", `/api/time-off/${ok.body.id}`, { cookie: cookie.a, body: { timeOffType: "NOPE" } });
    assert.equal(moved.status, 400, show(moved));
    const changed = await call("PATCH", `/api/time-off/${ok.body.id}`, { cookie: cookie.a, body: { timeOffType: "unpaid" } });
    assert.equal(changed.status, 200, show(changed));
    assert.equal(changed.body.type, "UNPAID");
  });

  // ── 6. Leave policies: the combined lookup ──────────────────────────────────
  console.log("6. leave policies answer policy ids and type ids:");
  await check("the list shows the Days Off type as the company-wide rule, then the branches' own; a manager limited to X reads X (200) and not Y (403)", async () => {
    const branchPolicy = await call("POST", "/api/leave-policies", {
      cookie: cookie.a,
      body: { name: `ZZ X policy ${run}`, daysWorkedRequired: 3, daysOffEarned: 1, branchId: A.x },
    });
    assert.equal(branchPolicy.status, 201, show(branchPolicy));
    const list = await call("GET", "/api/leave-policies", { cookie: cookie.a });
    assert.equal(list.status, 200, show(list));
    const daysOff = byCode(typesA, "CHANGE_DAY_OFF");
    assert.equal(list.body[0].id, daysOff.id);
    assert.equal(list.body[0].branchId, null);
    assert.ok((list.body as { id: string }[]).some((p) => p.id === branchPolicy.body.id));
    assert.ok(!(list.body as { id: string }[]).some((p) => p.id === legacyCompanyWide.A), "the pre-0018 company-wide row is the type now");
    const forX = await call("GET", `/api/leave-policies?branchId=${A.x}`, { cookie: cookie.aLimited });
    assert.equal(forX.status, 200, show(forX));
    assert.deepEqual((forX.body as { id: string }[]).map((p) => p.id), [branchPolicy.body.id]);
    assert.equal((await call("GET", `/api/leave-policies?branchId=${A.y}`, { cookie: cookie.aLimited })).status, 403);
    // Y has no policy of its own: the company-wide rule, answered for Y.
    const forY = await call("GET", `/api/leave-policies?branchId=${A.y}`, { cookie: cookie.a });
    assert.deepEqual((forY.body as { id: string; branchId: string }[]).map((p) => [p.id, p.branchId]), [[daysOff.id, A.y]]);
  });

  await check("PATCH and DELETE take a pre-0018 company-wide policy's id, the Days Off type's id and a branch policy's id; another park group's is the 404", async () => {
    const daysOff = byCode(typesA, "CHANGE_DAY_OFF");
    const viaLegacy = await call("PATCH", `/api/leave-policies/${legacyCompanyWide.A}`, { cookie: cookie.a, body: { daysWorkedRequired: 6 } });
    assert.equal(viaLegacy.status, 200, show(viaLegacy));
    assert.equal(viaLegacy.body.id, daysOff.id);
    const viaType = await call("PATCH", `/api/leave-policies/${daysOff.id}`, { cookie: cookie.a, body: { daysOffEarned: 2 } });
    assert.equal(viaType.status, 200, show(viaType));
    const now = byCode(await typesOf(cookie.a), "CHANGE_DAY_OFF");
    assert.deepEqual([now.daysWorkedRequired, now.daysOffEarned], [6, 2]);
    const branchPolicy = (await q<{ id: string }>("select id from leave_policies where tenant_id = $1 and branch_id = $2", [A.tenant, A.x]))[0]!.id;
    const viaBranch = await call("PATCH", `/api/leave-policies/${branchPolicy}`, { cookie: cookie.a, body: { daysWorkedRequired: 7 } });
    assert.equal(viaBranch.status, 200, show(viaBranch));
    assert.equal(viaBranch.body.daysWorkedRequired, 7);
    // B reaches none of them.
    for (const id of [legacyCompanyWide.A, daysOff.id, branchPolicy]) {
      for (const [method, body] of [["PATCH", { name: "ZZ hijack" }], ["DELETE", undefined]] as const) {
        const res = await call(method, `/api/leave-policies/${id}`, { cookie: cookie.b, ...(body ? { body } : {}) });
        assert.equal(res.status, 404, `${method} ${id}: ${show(res)}`);
      }
    }
    assert.equal(byCode(await typesOf(cookie.a), "CHANGE_DAY_OFF").name, "Days Off");
    // Deleting the company-wide rule switches the type off; a branch policy is removed.
    assert.equal((await call("DELETE", `/api/leave-policies/${legacyCompanyWide.A}`, { cookie: cookie.a })).status, 204);
    assert.equal(byCode(await typesOf(cookie.a), "CHANGE_DAY_OFF").isActive, false);
    assert.equal((await call("PATCH", `/api/leave-types/${daysOff.id}`, { cookie: cookie.a, body: { isActive: true } })).status, 200);
    assert.equal((await call("DELETE", `/api/leave-policies/${branchPolicy}`, { cookie: cookie.a })).status, 204);
    assert.equal(await count("select count(*) as n from leave_policies where id = $1", [branchPolicy]), 0);
  });

  // ── 7. Settings and the sick-leave policy read and save the types ──────────
  console.log("7. the settings keys and the sick-leave policy are the types:");
  await check("GET /api/settings answers A's types for the leave keys; a save changes A's type and not B's; a bad value saves nothing", async () => {
    const value = async (c: string, key: string) =>
      ((await call("GET", "/api/settings", { cookie: c })).body as { key: string; value: string }[]).find((s) => s.key === key)?.value;
    assert.equal(await value(cookie.a, "annual_leave_total_days"), String(legacy.A.annual));
    const saved = await call("POST", "/api/settings", {
      cookie: cookie.a,
      body: [{ key: "annual_leave_total_days", value: "11" }, { key: "business_days_total", value: "4" }],
    });
    assert.equal(saved.status, 200, show(saved));
    assert.equal(byCode(await typesOf(cookie.a), "ANNUAL").annualDays, 11);
    assert.equal(byCode(await typesOf(cookie.a), "BUSINESS").annualDays, 4);
    assert.equal(await value(cookie.a, "annual_leave_total_days"), "11");
    assert.equal(byCode(await typesOf(cookie.b), "ANNUAL").annualDays, legacy.B.annual);
    const refused = await call("POST", "/api/settings", { cookie: cookie.a, body: [{ key: "annual_leave_waiting_months", value: "1.5" }] });
    assert.equal(refused.status, 400, show(refused));
    assert.equal(byCode(await typesOf(cookie.a), "ANNUAL").waitingMonths, legacy.A.wait);
  });

  await check("the company-wide sick-leave save is A's Sick Leave type; B's stays its own; a branch save is that branch's row", async () => {
    const saved = await call("POST", "/api/sick-leave-policy", { cookie: cookie.a, body: { annualSickLeaveDays: 9 } });
    assert.equal(saved.status, 200, show(saved));
    assert.equal(byCode(await typesOf(cookie.a), "SICK").annualDays, 9);
    assert.equal((await call("GET", "/api/sick-leave-policy", { cookie: cookie.a })).body.annualSickLeaveDays, 9);
    assert.equal((await call("GET", "/api/sick-leave-policy", { cookie: cookie.b })).body.annualSickLeaveDays, legacy.B.sick);
    const branch = await call("POST", "/api/sick-leave-policy", { cookie: cookie.a, body: { branchId: A.x, annualSickLeaveDays: 15 } });
    assert.equal(branch.status, 200, show(branch));
    assert.equal((await call("GET", `/api/sick-leave-policy?branchId=${A.x}`, { cookie: cookie.a })).body.annualSickLeaveDays, 15);
    assert.equal((await call("GET", `/api/sick-leave-policy?branchId=${A.x}`, { cookie: cookie.b })).status, 404);
    assert.equal((await call("POST", "/api/sick-leave-policy", { cookie: cookie.b, body: { branchId: A.x, annualSickLeaveDays: 1 } })).status, 404);
  });

  console.log(`leave-types.check: ${checks} checks passed`);
} catch (err) {
  console.error("leave-types.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  // Our settings rows go: tests/tenant-ownership.check.ts puts the old
  // one-row-per-key unique back for a while, which two park groups' rows for
  // the same key would refuse.
  await q("delete from settings where tenant_id = any($1)", [[A.tenant, B.tenant]]).catch(() => undefined);
  await pool.end();
}
