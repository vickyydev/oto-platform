// seed: its own — two park groups' worth of ZZ TEST rows, made here. Not a
// Playwright file (the suite collects *.spec.ts and *.test.ts; this is
// neither): it boots the app's real routes and needs a database with the
// otoapp schema migrated.
//
// SCRUM-561 (the October Replit port, R4) — staff birthdays and the sidebar,
// over HTTP against the routes as registered and in the database migrations
// 0019 and 0020 made:
//
//   1. Birthday validation: February 29 is valid without a year or in a leap
//      year only; impossible combinations are the 400; the database CHECK
//      refuses what the routes would; an employee create/edit says the same.
//   2. My Account: the employee record is authoritative and the account copy
//      follows it; an account with no employee keeps its own; the other
//      direction (an edit of the employee) is what My Account then reads.
//   3. /api/birthdays: fenced to the caller's park group and allowed branches,
//      the branch filter, the 370-day limit, February 29 observed on the 28th.
//   4. Sidebar sections: two PATCHes merge (the union survives), bad bodies
//      are the 400, one person's choices never reach another's.
//   5. Badges: counted only over the caller's park group and allowed branches;
//      a requested branch outside them adds nothing.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/birthdays-sidebar.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("birthdays-sidebar.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
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

// ─── Two park groups of our own ──────────────────────────────────────────────

interface ParkGroup {
  tenant: string;
  operator: string;
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

async function employee(
  g: ParkGroup, branch: string, nickname: string,
  opts: { month?: number; day?: number; year?: number | null; userId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, user_id,
                            birthday_month, birthday_day, birthday_year)
     values ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10)`,
    [id, g.tenant, branch, `ZZ TEST ${run} ${nickname}`, nickname, `zz-bd-${nickname}-${id.slice(0, 8)}@example.com`,
      opts.userId ?? null, opts.month ?? null, opts.day ?? null, opts.year ?? null],
  );
  return id;
}

async function parkGroup(label: string): Promise<ParkGroup> {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST bd ${label} ${run}`, `zz-bd-${label}-${run}`]);
  const operator = randomUUID();
  await q("insert into operators (id, tenant_id, name) values ($1, $2, $3)", [operator, tenant, `ZZ TEST bd ${label} ${run}`]);
  const x = randomUUID();
  const y = randomUUID();
  for (const [id, suffix] of [[x, "x"], [y, "y"]] as const) {
    await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
      id, tenant, `ZZ TEST bd ${label} ${suffix} ${run}`,
    ]);
  }
  const adminEmail = `zz-bd-${label}-admin-${run}@example.com`;
  const limitedEmail = `zz-bd-${label}-limited-${run}@example.com`;
  return {
    tenant, operator, x, y,
    admin: { id: await user(tenant, "admin", adminEmail, null), email: adminEmail },
    limited: { id: await user(tenant, "manager", limitedEmail, x), email: limitedEmail },
  };
}

const A = await parkGroup("a");
const B = await parkGroup("b");

// A's staff: a linked staff account with an employee record, one without a
// record, and birthdays set directly so the listing has known content.
const staffEmail = `zz-bd-staff-${run}@example.com`;
const staffUser = await user(A.tenant, "staff", staffEmail, A.x);
const staffEmployee = await employee(A, A.x, `StaffX${RUN}`, { userId: staffUser });
const loneEmail = `zz-bd-lone-${run}@example.com`;
const loneUser = await user(A.tenant, "staff", loneEmail, A.x);
const empX = await employee(A, A.x, `AmyX${RUN}`, { month: 3, day: 14, year: 1990 });
const empY = await employee(A, A.y, `BobY${RUN}`, { month: 3, day: 15 });
const empLeap = await employee(A, A.x, `LeapX${RUN}`, { month: 2, day: 29 });
const empForeign = await employee(B, B.x, `ForeignB${RUN}`, { month: 3, day: 14 });

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

type Birthday = { id: string; personId: string; name: string; date: string; branchId: string | null; title: string };
const names = (rows: Birthday[]) => rows.map((r) => r.name).sort();

try {
  ORIGIN = await serve();
  const cookie = {
    a: await signIn(A.admin.email),
    aLimited: await signIn(A.limited.email),
    b: await signIn(B.admin.email),
    staff: await signIn(staffEmail),
    lone: await signIn(loneEmail),
  };
  const mine = (c: string) => call("GET", "/api/my-account/birthday", { cookie: c });
  const patchMine = (c: string, body: unknown) => call("PATCH", "/api/my-account/birthday", { cookie: c, body });
  const list = async (c: string, qs: string) => call("GET", `/api/birthdays?${qs}`, { cookie: c });

  // ── 1. Validation ───────────────────────────────────────────────────────────
  console.log("1. birthday validation:");
  await check("February 29 is valid without a year or in a leap year, and nowhere else", async () => {
    assert.equal((await patchMine(cookie.staff, { month: 2, day: 29, year: null })).status, 200);
    assert.equal((await patchMine(cookie.staff, { month: 2, day: 29, year: 2000 })).status, 200);
    const bad = await patchMine(cookie.staff, { month: 2, day: 29, year: 2001 });
    assert.equal(bad.status, 400, show(bad));
    assert.match(bad.body.message, /valid birthday/i);
  });
  await check("impossible and half-given combinations are the 400, and nothing is stored", async () => {
    for (const body of [
      { month: 13, day: 1, year: null }, { month: 4, day: 31, year: null }, { month: 0, day: 5, year: null },
      { month: 3, day: null, year: null }, { month: null, day: 3, year: null }, { month: 3, day: 3, year: 0 },
      { month: 3, day: 3, year: 10000 }, { month: 3, day: 3, year: null, extra: 1 }, { month: "3", day: 3, year: null },
    ]) {
      const res = await patchMine(cookie.staff, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${show(res)}`);
    }
    const stored = await q<{ birthday_month: number; birthday_day: number; birthday_year: number }>(
      "select birthday_month, birthday_day, birthday_year from employees where id = $1", [staffEmployee]);
    assert.deepEqual([stored[0]!.birthday_month, stored[0]!.birthday_day, stored[0]!.birthday_year], [2, 29, 2000]);
  });
  await check("the database refuses what the routes would", async () => {
    await assert.rejects(q("update employees set birthday_month = 2, birthday_day = 30 where id = $1", [empX]), /employees_birthday_valid/);
    await assert.rejects(q("update users set birthday_month = 6, birthday_day = 31 where id = $1", [loneUser]), /users_birthday_valid/);
    await assert.rejects(q("update employees set birthday_day = null where id = $1", [empX]), /employees_birthday_valid/);
  });
  await check("an employee edit and an employee create name the same birthday rules", async () => {
    const edit = await call("PATCH", `/api/employees/${empX}`, { cookie: cookie.a, body: { birthdayMonth: 2, birthdayDay: 30 } });
    assert.equal(edit.status, 400, show(edit));
    assert.match(edit.body.message, /valid birthday/i);
    const half = await call("PATCH", `/api/employees/${empX}`, { cookie: cookie.a, body: { birthdayMonth: null } });
    assert.equal(half.status, 400, show(half)); // day stays, month goes: half a birthday
    const create = await call("POST", "/api/employees", {
      cookie: cookie.a,
      body: { fullName: `ZZ TEST ${run} new`, nickname: `New${RUN}`, email: `zz-bd-new-${run}@example.com`, phone: "0800000000", branchId: A.x, birthdayMonth: 4, birthdayDay: 31 },
    });
    assert.equal(create.status, 400, show(create));
    assert.match(create.body.message, /valid birthday/i);
    const ok = await call("PATCH", `/api/employees/${empX}`, { cookie: cookie.a, body: { birthdayMonth: 3, birthdayDay: 14, birthdayYear: 1990 } });
    assert.equal(ok.status, 200, show(ok));
  });

  // ── 2. My Account ───────────────────────────────────────────────────────────
  console.log("2. My Account:");
  await check("a linked account saves to the employee record and the account copy, and reads the employee's", async () => {
    const saved = await patchMine(cookie.staff, { month: 7, day: 21, year: 1995 });
    assert.equal(saved.status, 200, show(saved));
    const emp = (await q<{ m: number; d: number; y: number }>("select birthday_month m, birthday_day d, birthday_year y from employees where id = $1", [staffEmployee]))[0]!;
    const acc = (await q<{ m: number; d: number; y: number }>("select birthday_month m, birthday_day d, birthday_year y from users where id = $1", [staffUser]))[0]!;
    assert.deepEqual([emp.m, emp.d, emp.y], [7, 21, 1995]);
    assert.deepEqual([acc.m, acc.d, acc.y], [7, 21, 1995]);
    assert.deepEqual((await mine(cookie.staff)).body, { month: 7, day: 21, year: 1995 });
  });
  await check("an edit of the employee record is what My Account then reads, even when the account copy differs", async () => {
    const edit = await call("PATCH", `/api/employees/${staffEmployee}`, { cookie: cookie.a, body: { birthdayMonth: 8, birthdayDay: 9, birthdayYear: null } });
    assert.equal(edit.status, 200, show(edit));
    assert.deepEqual((await mine(cookie.staff)).body, { month: 8, day: 9, year: null });
    // A linked employee with none set reads none, never the stale account copy.
    await q("update employees set birthday_month = null, birthday_day = null, birthday_year = null where id = $1", [staffEmployee]);
    assert.deepEqual((await mine(cookie.staff)).body, { month: null, day: null, year: null });
  });
  await check("an account with no employee record keeps its own birthday; Clear empties it", async () => {
    assert.equal((await patchMine(cookie.lone, { month: 12, day: 25, year: null })).status, 200);
    assert.deepEqual((await mine(cookie.lone)).body, { month: 12, day: 25, year: null });
    assert.equal(await count("select count(*) n from users where id = $1 and birthday_month = 12 and birthday_day = 25", [loneUser]), 1);
    assert.equal((await patchMine(cookie.lone, { month: null, day: null, year: null })).status, 200);
    assert.deepEqual((await mine(cookie.lone)).body, { month: null, day: null, year: null });
    assert.equal((await call("GET", "/api/my-account/birthday")).status, 401);
  });

  // ── 3. The listing ──────────────────────────────────────────────────────────
  console.log("3. /api/birthdays:");
  const year = new Date().getUTCFullYear();
  await check("a park group sees its own staff and nobody else's", async () => {
    const res = await list(cookie.a, `start=${year}-03-01&end=${year}-03-31`);
    assert.equal(res.status, 200, show(res));
    const got = names(res.body);
    assert.ok(got.includes(`AmyX${RUN}`) && got.includes(`BobY${RUN}`), got.join());
    assert.ok(!got.includes(`ForeignB${RUN}`), "another park group's staff is absent");
    assert.deepEqual(res.body.find((r: Birthday) => r.name === `AmyX${RUN}`).date, `${year}-03-14`);
    const other = await list(cookie.b, `start=${year}-03-01&end=${year}-03-31`);
    assert.deepEqual(names(other.body).filter((n) => n.endsWith(RUN)), [`ForeignB${RUN}`]);
  });
  await check("the branch filter narrows; a branch outside the caller's reach is refused or unknown", async () => {
    const x = await list(cookie.a, `start=${year}-03-01&end=${year}-03-31&branchId=${A.x}`);
    assert.deepEqual(names(x.body).filter((n) => n.endsWith(RUN)), [`AmyX${RUN}`]);
    const limited = await list(cookie.aLimited, `start=${year}-03-01&end=${year}-03-31`);
    assert.deepEqual(names(limited.body).filter((n) => n.endsWith(RUN)), [`AmyX${RUN}`]);
    assert.equal((await list(cookie.aLimited, `start=${year}-03-01&end=${year}-03-31&branchId=${A.y}`)).status, 403);
    assert.equal((await list(cookie.b, `start=${year}-03-01&end=${year}-03-31&branchId=${A.x}`)).status, 404);
  });
  await check("the range must be real dates, in order, at most 370 days", async () => {
    for (const qs of [
      `start=${year}-01-01&end=${year + 1}-01-07`, `start=${year}-03-31&end=${year}-03-01`, `start=${year}-02-30&end=${year}-03-01`,
      `start=nope&end=${year}-03-01`, `start=${year}-03-01`,
    ]) assert.equal((await list(cookie.a, qs)).status, 400, qs);
    assert.equal((await list(cookie.a, `start=${year}-01-01&end=${year + 1}-01-06`)).status, 200);
    assert.equal((await call("GET", `/api/birthdays?start=${year}-03-01&end=${year}-03-02`)).status, 401);
  });
  await check("February 29 is observed on February 28 in a common year and on the 29th in a leap year", async () => {
    const common = await list(cookie.a, "start=2027-02-01&end=2027-03-01");
    assert.equal(common.body.find((r: Birthday) => r.name === `LeapX${RUN}`)?.date, "2027-02-28");
    const leap = await list(cookie.a, "start=2028-02-01&end=2028-03-01");
    assert.equal(leap.body.find((r: Birthday) => r.name === `LeapX${RUN}`)?.date, "2028-02-29");
    assert.match(leap.body.find((r: Birthday) => r.name === `LeapX${RUN}`).title, /Birthday/);
  });
  await check("a person who has left is not celebrated", async () => {
    await q("update employees set employment_state = 'LEFT' where id = $1", [empY]);
    const res = await list(cookie.a, `start=${year}-03-01&end=${year}-03-31`);
    assert.ok(!names(res.body).includes(`BobY${RUN}`));
    await q("update employees set employment_state = 'ACTIVE' where id = $1", [empY]);
  });

  // ── 4. Sidebar sections ─────────────────────────────────────────────────────
  console.log("4. sidebar sections:");
  const sections = (c: string) => call("GET", "/api/me/sidebar-sections", { cookie: c });
  const patchSections = (c: string, body: unknown) => call("PATCH", "/api/me/sidebar-sections", { cookie: c, body });
  await check("a new account reads none; two PATCHes merge so the union survives; a later PATCH changes only its key", async () => {
    assert.deepEqual((await sections(cookie.a)).body, { sections: {} });
    assert.deepEqual((await patchSections(cookie.a, { sections: { finance: true } })).body, { sections: { finance: true } });
    assert.deepEqual((await patchSections(cookie.a, { sections: { payroll: false } })).body, { sections: { finance: true, payroll: false } });
    assert.deepEqual((await sections(cookie.a)).body, { sections: { finance: true, payroll: false } });
    assert.deepEqual((await patchSections(cookie.a, { sections: { finance: false } })).body, { sections: { finance: false, payroll: false } });
    // Two at once: both keys land.
    await Promise.all([patchSections(cookie.a, { sections: { configuration: true } }), patchSections(cookie.a, { sections: { platformAdmin: true } })]);
    assert.deepEqual((await sections(cookie.a)).body, { sections: { finance: false, payroll: false, configuration: true, platformAdmin: true } });
    assert.equal(await count("select count(*) n from user_preferences where user_id = $1", [A.admin.id]), 1);
  });
  await check("bad bodies are the 400, and one person's choices never reach another's", async () => {
    for (const body of [{}, { sections: {} }, { sections: { finance: "yes" } }, { sections: { "": true } }, { sections: [true] }, { finance: true }]) {
      assert.equal((await patchSections(cookie.a, body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await sections(cookie.b)).body, { sections: {} });
    assert.equal((await sections(undefined as unknown as string)).status, 401);
  });
  await check("the preferences go with the account", async () => {
    const gone = await user(A.tenant, "staff", `zz-bd-gone-${run}@example.com`, A.x);
    await q("insert into user_preferences (user_id, preferences) values ($1, '{}')", [gone]);
    await q("delete from user_branch_access where user_id = $1", [gone]);
    await q("delete from users where id = $1", [gone]);
    assert.equal(await count("select count(*) n from user_preferences where user_id = $1", [gone]), 0);
  });

  // ── 5. Badges ───────────────────────────────────────────────────────────────
  console.log("5. badges:");
  async function attention(g: ParkGroup, branch: string, status: string) {
    await q(
      `insert into attention_items (id, tenant_id, branch_id, type, title, status)
       values ($1, $2, $3, 'EMPLOYEE_MISSING_ROLE', $4, $5)`,
      [randomUUID(), g.tenant, branch, `ZZ TEST ${run}`, status],
    );
  }
  const bangkokToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
  async function pendingRequest(g: ParkGroup, branch: string, employeeId: string) {
    await q(
      `insert into time_adjustments (tenant_id, operator_id, employee_id, branch_id, work_date, adjustment_type, requested_by, approval_status)
       values ($1, $2, $3, $4, $5, 'ADD_PUNCH', $6, 'PENDING')`,
      [g.tenant, g.operator, employeeId, branch, bangkokToday, g.admin.id],
    );
  }
  await attention(A, A.x, "open");
  await attention(A, A.x, "open");
  await attention(A, A.y, "open");
  await attention(A, A.y, "resolved");
  await attention(B, B.x, "open");
  await pendingRequest(A, A.x, empX);
  await pendingRequest(A, A.y, empY);
  await pendingRequest(B, B.x, empForeign);
  const badges = (c: string, qs = "") => call("GET", `/api/sidebar/badges${qs}`, { cookie: c });
  // The attention engine also raises items of its own for the staff made
  // above, so the open count is read from the table, by the same fence, at
  // the moment of asking; the attendance count is ours alone (today's pending
  // clock requests) and exact.
  const open = (branches: string[]) =>
    count("select count(*) n from attention_items where status = 'open' and branch_id = any($1)", [branches]);
  const counts = async (c: string, qs: string, branches: string[], attendance: number) => {
    const res = await badges(c, qs);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(res.body, { needsAction: await open(branches), todaysAttendance: attendance }, `${qs} -> ${show(res)}`);
  };
  await check("an admin counts their own park group's open items and today's flags, nobody else's", async () => {
    await counts(cookie.a, "", [A.x, A.y], 2);
    await counts(cookie.b, "", [B.x, B.y], 1);
    assert.ok((await open([A.x, A.y])) >= 3 && (await open([B.x])) >= 1);
    assert.notEqual((await badges(cookie.a)).body.needsAction, (await open([A.x, A.y, B.x, B.y])), "B's items are not in A's count");
  });
  await check("a requested branch narrows but never widens: a foreign branch adds nothing", async () => {
    await counts(cookie.a, `?branchIds=${A.x}`, [A.x], 1);
    await counts(cookie.a, `?branchIds=${A.x},${B.x}`, [A.x], 1);
    await counts(cookie.a, `?branchIds=${B.x}`, [], 0);
    await counts(cookie.a, "?branchIds=", [], 0);
  });
  await check("a manager limited to X counts X only, whatever they ask for", async () => {
    await counts(cookie.aLimited, "", [A.x], 1);
    await counts(cookie.aLimited, `?branchIds=${A.x},${A.y}`, [A.x], 1);
    await counts(cookie.aLimited, `?branchIds=${A.y}`, [], 0);
    assert.equal((await badges(undefined as unknown as string)).status, 401);
  });

  console.log(`birthdays-sidebar.check: ${checks} checks passed`);
} catch (err) {
  console.error("birthdays-sidebar.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
