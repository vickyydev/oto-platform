// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
// The platform is a local stand-in on 127.0.0.1 that answers the two calls
// the sign-on makes (the hand-off exchange and GET /me); nothing leaves the
// machine.
//
// SCRUM-673 — Schedule History names who was really there in a view-as
// window. Each session below is opened the way the launcher opens one: a
// hand-off token posted to /api/auth/handoff, exchanged by the app's own
// sign-on middleware, which keeps the platform's view-as mark on the session
// and puts it on every request (HARNESS_REQUEST_CONTEXT=1 runs the request
// context server/index.ts installs). Over HTTP against the routes as
// registered:
//
//   1. An ordinary action — a launcher session with no window, and a password
//      session — records the signed-in user as the one who did it, and no
//      view-as record.
//   2. A permitted (write-allowed) window records the same user, plus the
//      platform account really acting, the account it acted for and the
//      window; Schedule History's list carries all four.
//   3. A forged actor in a request body is ignored: outside a window it
//      creates no view-as record, inside one it does not replace the window's.
//   4. A read-only window is still refused every write, and writes nothing.
//   5. A permitted window still never reaches payroll or contracts.
//   6. The record cannot be set or changed from Data Admin, and the table
//      refuses a half-written one.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/s673-schedule-view-as.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  IMPERSONATION_READ_ONLY_MESSAGE, IMPERSONATION_REFUSED_MESSAGE, PLATFORM_SESSION_COOKIE, VIEW_AS_RECORD_REFUSAL,
} from "../server/lib/platformSession";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("s673-schedule-view-as.check: DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const DAY_MS = 86_400_000;
const monday = (offsetWeeks: number) => {
  const t = Date.now() + offsetWeeks * 7 * DAY_MS;
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ─── One park group, its subject, and a Data Admin ───────────────────────────

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s673 ${run}`, `zz-s673-${run}`]);
const BRANCH = randomUUID();
await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [BRANCH, TENANT, `ZZ TEST s673 park ${run}`]);
const DEPARTMENT = randomUUID();
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [DEPARTMENT, TENANT, `ZZ TEST s673 department ${run}`]);

/** The platform accounts: the subject (whose session it is), the support administrator really acting, and a forged one. */
const SUBJECT_ACCOUNT = randomUUID();
const ACTOR_ACCOUNT = randomUUID();
const FORGED = randomUUID();

async function user(role: string, label: string, platformUserId: string | null) {
  const id = randomUUID();
  const email = `zz-s673-${label}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, email, hash(PASSWORD), `ZZ TEST s673 ${label} ${run}`, role, platformUserId],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [TENANT, id]);
  return { id, email };
}
const subject = await user("admin", "subject", SUBJECT_ACCOUNT);
const bystander = await user("admin", "bystander", null);
const dataAdmin = await user("global_admin", "data-admin", null);

const mark = (mode: "read_only" | "write_allowed") => ({
  id: randomUUID(), actorAccountId: ACTOR_ACCOUNT, subjectAccountId: SUBJECT_ACCOUNT, mode,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), actorName: "ZZ TEST support", subjectName: "ZZ TEST subject",
});
const WRITE = mark("write_allowed");
const READ = mark("read_only");
const TOKENS: Record<string, typeof WRITE | null> = {
  [`zz-plain-${run}`]: null,
  [`zz-write-${run}`]: WRITE,
  [`zz-read-${run}`]: READ,
};

// ─── The platform's stand-in: the exchange and GET /me ───────────────────────

const platform = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/auth/handoff/exchange") {
      const token = (JSON.parse(raw || "{}") as { token?: string }).token ?? "";
      if (!(token in TOKENS)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unauthorized", message: "ZZ TEST", details: { reason: "invalid_token" } } }));
        return;
      }
      const window = TOKENS[token];
      res.writeHead(200, { "content-type": "application/json", "set-cookie": `${PLATFORM_SESSION_COOKIE}=zz-${token}; Path=/; HttpOnly` });
      res.end(JSON.stringify({ accountId: SUBJECT_ACCOUNT, mustChangePassword: false, ...(window ? { impersonation: window } : {}) }));
      return;
    }
    if (req.method === "GET" && req.url === "/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_ORIGIN = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;

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
  PLATFORM_API_URL: PLATFORM_ORIGIN,
  OTOAPP_PUBLIC_ORIGIN: "http://zz-s673.invalid",
  HARNESS_REQUEST_CONTEXT: "1",
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
    const timer = setTimeout(() => reject(new Error("harness did not start")), 90_000);
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
      reject(new Error(`harness exited ${code}`));
    });
  });
}

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON answer read field by field below
}

let ORIGIN = "";
async function call(method: string, path: string, cookie: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (a 204 has no body) — kept as text.
  }
  return { status: res.status, body: parsed };
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)}`;
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** A session opened the launcher's way: the hand-off token posted to the app, exchanged by its sign-on. */
async function handOff(token: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/auth/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(res.status, 200, `hand-off: ${res.status}`);
  return cookieOf(res);
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in: ${res.status}`);
  return cookieOf(res);
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

let week = 0;
/** A department week to clear: the request Schedule History records as "Week Cleared". */
const clearBody = (extra: Record<string, unknown> = {}) => {
  const start = monday(10 + week++);
  return { branchId: BRANCH, departmentId: DEPARTMENT, startDate: start, endDate: plus(start, 6), ...extra };
};
/** The history row a clear wrote, everything that says who did it. */
async function cleared(startDate: string) {
  const rows = await q(
    `select performed_by, actor_type, actor_account_id, on_behalf_of, impersonation_id from schedule_audit_log
      where tenant_id = $1 and department_id = $2 and week_start_date = $3 and action = 'clear_week'`,
    [TENANT, DEPARTMENT, startDate],
  );
  assert.equal(rows.length, 1, `one history row for ${startDate}`);
  return rows[0];
}
const ORDINARY = (performedBy: string) => ({ performed_by: performedBy, actor_type: null, actor_account_id: null, on_behalf_of: null, impersonation_id: null });
const VIEW_AS = (window: typeof WRITE) => ({ performed_by: subject.id, actor_type: "impersonated", actor_account_id: ACTOR_ACCOUNT,
  on_behalf_of: SUBJECT_ACCOUNT, impersonation_id: window.id });
const FORGERY = { performedBy: bystander.id, actorType: "impersonated", actorAccountId: FORGED, onBehalfOf: FORGED, impersonationId: FORGED,
  actor_type: "impersonated", actor_account_id: FORGED, on_behalf_of: FORGED, impersonation_id: FORGED, viewAs: { actorAccountId: FORGED } };

async function weekPlan(): Promise<string> {
  const id = randomUUID();
  await q("insert into schedule_week_plans (id, tenant_id, branch_id, week_start_date) values ($1, $2, $3, $4)", [id, TENANT, BRANCH, monday(40 + week++)]);
  return id;
}
const historyCount = async () => Number((await q<{ n: string }>("select count(*) as n from schedule_audit_log where tenant_id = $1", [TENANT]))[0]!.n);

try {
  ORIGIN = await serve();
  const plain = await handOff(`zz-plain-${run}`);
  const write = await handOff(`zz-write-${run}`);
  const readOnly = await handOff(`zz-read-${run}`);
  const password = await signIn(subject.email);

  console.log("1. an ordinary action:");
  await check("a launcher session with no window and a password session record the signed-in user, and no view-as record", async () => {
    for (const cookie of [plain, password]) {
      const body = clearBody();
      const res = await call("POST", "/api/schedule/clear", cookie, body);
      assert.equal(res.status, 200, show(res));
      assert.deepEqual(await cleared(body.startDate), ORDINARY(subject.id));
    }
  });

  console.log("2. a permitted view-as window:");
  await check("records the user whose session it is, the account really acting, the account it acted for and the window", async () => {
    const body = clearBody();
    const res = await call("POST", "/api/schedule/clear", write, body);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(await cleared(body.startDate), VIEW_AS(WRITE));
    const plan = await weekPlan();
    const removed = await call("DELETE", `/api/schedule/week/${plan}`, write);
    assert.equal(removed.status, 204, show(removed));
    const [row] = await q("select performed_by, actor_type, actor_account_id, on_behalf_of, impersonation_id from schedule_audit_log where week_plan_id = $1", [plan]);
    assert.deepEqual(row, VIEW_AS(WRITE), "every schedule history writer carries it, not one route");
  });
  await check("Schedule History's list carries the view-as record, and nothing on an ordinary row", async () => {
    const res = await call("GET", `/api/schedule/audit-log?branchId=${BRANCH}&limit=200`, password);
    assert.equal(res.status, 200, show(res));
    const viewAs = res.body.filter((e: Answer["body"]) => e.actorType === "impersonated");
    assert.ok(viewAs.length >= 2, show(res));
    for (const e of viewAs) {
      assert.deepEqual([e.performedBy, e.actorAccountId, e.onBehalfOf, e.impersonationId], [subject.id, ACTOR_ACCOUNT, SUBJECT_ACCOUNT, WRITE.id]);
    }
    for (const e of res.body.filter((x: Answer["body"]) => x.actorType !== "impersonated")) {
      assert.deepEqual([e.actorType, e.actorAccountId, e.onBehalfOf, e.impersonationId], [null, null, null, null]);
    }
  });

  console.log("3. a forged actor in a request body:");
  await check("outside a window it creates no view-as record and does not change who did it", async () => {
    const body = clearBody(FORGERY);
    const res = await call("POST", "/api/schedule/clear", plain, body);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(await cleared(body.startDate), ORDINARY(subject.id));
  });
  await check("inside a window it does not replace the window's actor, subject or id", async () => {
    const body = clearBody(FORGERY);
    const res = await call("POST", "/api/schedule/clear", write, body);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(await cleared(body.startDate), VIEW_AS(WRITE));
  });

  console.log("4. a read-only window:");
  await check("every schedule write is still refused in the window's words, and nothing is written", async () => {
    const before = await historyCount();
    const plan = await weekPlan();
    const refused = { reason: "impersonation_read_only", message: IMPERSONATION_READ_ONLY_MESSAGE };
    const clear = await call("POST", "/api/schedule/clear", readOnly, clearBody());
    assert.deepEqual([clear.status, clear.body], [403, refused], show(clear));
    const removed = await call("DELETE", `/api/schedule/week/${plan}`, readOnly);
    assert.deepEqual([removed.status, removed.body], [403, refused], show(removed));
    assert.equal(await historyCount(), before);
    assert.equal((await q("select id from schedule_week_plans where id = $1", [plan])).length, 1, "the week is still there");
    const list = await call("GET", `/api/schedule/audit-log?branchId=${BRANCH}`, readOnly);
    assert.equal(list.status, 200, "reading Schedule History stays open");
  });

  console.log("5. payroll and contracts:");
  await check("a permitted window still never reaches payroll or contracts", async () => {
    const refused = { reason: "impersonation_refused", message: IMPERSONATION_REFUSED_MESSAGE };
    for (const path of ["/api/payroll/month-status", "/api/contracts"]) {
      const res = await call("GET", path, write);
      assert.deepEqual([res.status, res.body], [403, refused], `${path}: ${show(res)}`);
    }
  });

  console.log("6. the record itself:");
  await check("Data Admin cannot set or change it, and saves a row it leaves as it was", async () => {
    const admin = await signIn(dataAdmin.email);
    const created = await call("POST", "/api/data-admin/schedule-audit-logs", admin,
      { action: "clear_week", description: "ZZ TEST forged", actorType: "impersonated", actorAccountId: FORGED, onBehalfOf: FORGED, impersonationId: FORGED });
    assert.deepEqual([created.status, created.body], [409, { error: VIEW_AS_RECORD_REFUSAL }], show(created));
    const [row] = await q<{ id: string }>("select id from schedule_audit_log where impersonation_id = $1 limit 1", [WRITE.id]);
    const before = await q("select * from schedule_audit_log where id = $1", [row!.id]);
    for (const change of [{ actorAccountId: FORGED }, { actorType: null, actorAccountId: null, onBehalfOf: null, impersonationId: null }]) {
      const res = await call("PUT", `/api/data-admin/schedule-audit-logs/${row!.id}`, admin, { description: "ZZ TEST edited", ...change });
      assert.deepEqual([res.status, res.body], [409, { error: VIEW_AS_RECORD_REFUSAL }], show(res));
    }
    assert.deepEqual(await q("select * from schedule_audit_log where id = $1", [row!.id]), before);
    const same = await call("PUT", `/api/data-admin/schedule-audit-logs/${row!.id}`, admin,
      { description: "ZZ TEST edited", actorType: "impersonated", actorAccountId: ACTOR_ACCOUNT, onBehalfOf: SUBJECT_ACCOUNT, impersonationId: WRITE.id });
    assert.equal(same.status, 200, show(same));
    const [after] = await q("select description, actor_type, actor_account_id, on_behalf_of, impersonation_id from schedule_audit_log where id = $1", [row!.id]);
    assert.deepEqual(after, { description: "ZZ TEST edited", actor_type: "impersonated", actor_account_id: ACTOR_ACCOUNT, on_behalf_of: SUBJECT_ACCOUNT,
      impersonation_id: WRITE.id });
  });
  await check("the table refuses a view-as record written by halves", async () => {
    for (const [type, actor, behalf, window] of [["impersonated", null, SUBJECT_ACCOUNT, WRITE.id], [null, ACTOR_ACCOUNT, null, null], ["someone", ACTOR_ACCOUNT, SUBJECT_ACCOUNT, WRITE.id]]) {
      await assert.rejects(
        q(`insert into schedule_audit_log (tenant_id, action, actor_type, actor_account_id, on_behalf_of, impersonation_id)
           values ($1, 'clear_week', $2, $3, $4, $5)`, [TENANT, type, actor, behalf, window]),
        (error: { code?: string }) => error.code === "23514",
      );
    }
  });

  console.log(`s673-schedule-view-as.check: ${checks} checks passed`);
} catch (err) {
  console.error("s673-schedule-view-as.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
