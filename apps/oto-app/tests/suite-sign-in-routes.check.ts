// seed: its own — one park group of ZZ TEST rows, and a second one to fence
// against, made here. Not a Playwright file. Boots the app's real routes
// (tests/harness/serve-routes.ts) and a stand-in platform, and needs a
// database whose otoapp schema the app's migrator has built.
//
// SCRUM-539 over HTTP, on the routes as registered:
//   - Setup > Users: "Provision suite sign-in" saves a Thai local phone as
//     E.164, asks the platform with the app's key and the acting
//     administrator, and answers the one-time password with no-store;
//     another park group's user is not found and the platform is never asked;
//   - an advisor with no login yet gets one made (role advisor, branch access
//     from their policy, a password nothing accepts), then is provisioned;
//   - with this app's own sign-in closed: a user is created with no password,
//     and a session is never told it owes this app a password change or an
//     SMS phone check (the forced /change-password and /verify-phone pages);
//   - with no key configured, the button's route says so and asks nothing.
//
// Usage, from apps/oto-app, with DATABASE_URL set:
//   npx tsx tests/suite-sign-in-routes.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("suite-sign-in-routes.check: DATABASE_URL is not set");
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

// ─── Rows ─────────────────────────────────────────────────────────────────────

async function parkGroup(label: string) {
  const tenant = randomUUID();
  const branch = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST ${label} ${run}`, `zz-539-${label}-${run}`]);
  await q("insert into branches (id, tenant_id, name, address) values ($1, $2, $3, 'ZZ TEST')", [branch, tenant, `ZZ TEST ${label} park ${run}`]);
  return { tenant, branch };
}
async function user(g: { tenant: string; branch: string }, role: string, opts: { mustChange?: boolean; phone?: string } = {}) {
  const id = randomUUID();
  const email = `zz-539-${role}-${id.slice(0, 6)}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, phone_number, phone_e164, phone_verified)
     values ($1, $2, $3, $4, $5, true, $6, $7, $7, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${role}`, role, opts.mustChange ?? false, opts.phone ?? null],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [g.tenant, id]);
  return { id, email };
}

const A = await parkGroup("a");
const B = await parkGroup("b");
const adminA = await user(A, "admin");
const staffA = await user(A, "staff");
const staffB = await user(B, "staff");
// An advisor made without a login: a person and an access policy, no user.
const advisorPerson = randomUUID();
const advisorEmail = `zz-539-advisor-${run}@example.com`;
await q("insert into people (id, tenant_id, full_name, email, person_type) values ($1, $2, 'ZZ TEST advisor', $3, 'ADVISOR')", [advisorPerson, A.tenant, advisorEmail]);
await q(
  `insert into access_policies (tenant_id, person_id, access_level, modules, branch_scope, branch_ids, core_account_enabled)
   values ($1, $2, 'MANAGER', '{"core":true,"hr":false,"studio":false,"events":false,"ops":false,"setup":false}'::jsonb, 'SELECTED', $3::jsonb, false)`,
  [A.tenant, advisorPerson, JSON.stringify([A.branch])],
);

// ─── The stand-in platform ────────────────────────────────────────────────────

const asked: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
const platform = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    asked.push({ headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: body.actionId, accountId: randomUUID(), phone: body.phone, externalUserId: body.appUserId, temporaryPassword: "Zz539abc", replayed: false }));
  });
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;

// ─── The app, twice: its own form on (to sign in), and closed ────────────────

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
      LOG_LEVEL: "warn",
      SESSION_SECRET,
      PLATFORM_API_URL,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  return new Promise((resolve, reject) => {
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
const SESSION_SECRET = randomBytes(24).toString("hex");

const call = async (origin: string, method: string, path: string, cookie: string, payload?: unknown) => {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any -- a check reads whatever came back
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body, headers: res.headers };
};

try {
  const legacy = await serve({ OTOAPP_LEGACY_LOGIN: "true", OTOAPP_PROVISION_KEY: "zz-539-key" });
  const closed = await serve({ OTOAPP_LEGACY_LOGIN: "false", OTOAPP_PROVISION_KEY: "zz-539-key" });
  const unkeyed = await serve({ OTOAPP_LEGACY_LOGIN: "true", OTOAPP_PROVISION_KEY: "" });

  const login = await fetch(`${legacy}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: adminA.email, password: PASSWORD }),
  });
  assert.equal(login.status, 200, `sign-in: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  // Setup > Users: a Thai local phone, the key, the actor, and no-store.
  const made = await call(legacy, "POST", `/api/users/${staffA.id}/suite-sign-in`, cookie, { actionId: randomUUID(), phone: "081-539-0001" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.temporaryPassword, "Zz539abc");
  assert.equal(made.headers.get("cache-control"), "no-store");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.headers.authorization, "Bearer zz-539-key");
  assert.equal(asked[0]!.headers.cookie, undefined, "no platform session travels");
  assert.deepEqual(
    { appUserId: asked[0]!.body.appUserId, phone: asked[0]!.body.phone, actorAppUserId: asked[0]!.body.actorAppUserId },
    { appUserId: staffA.id, phone: "+66815390001", actorAppUserId: adminA.id },
  );
  const [saved] = await q<{ phone_e164: string }>("select phone_e164 from users where id = $1", [staffA.id]);
  assert.equal(saved!.phone_e164, "+66815390001", "the phone is kept on the user");

  // Another park group's user: not found, and the platform is never asked.
  const fenced = await call(legacy, "POST", `/api/users/${staffB.id}/suite-sign-in`, cookie, { actionId: randomUUID(), phone: "0815390002" });
  assert.equal(fenced.status, 404);
  const noAction = await call(legacy, "POST", `/api/users/${staffA.id}/suite-sign-in`, cookie, { phone: "0815390002" });
  assert.equal(noAction.status, 400, "a press without an action id is refused");
  assert.equal(asked.length, 1);

  // An advisor with no login: one is made, then provisioned.
  const status = await call(legacy, "GET", `/api/people/${advisorPerson}/suite-sign-in`, cookie);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.hasLogin, false);
  assert.equal(status.body.configured, true);
  const advisor = await call(legacy, "POST", `/api/people/${advisorPerson}/suite-sign-in`, cookie, { actionId: randomUUID(), phone: "0815390003" });
  assert.equal(advisor.status, 200, JSON.stringify(advisor.body));
  const [advisorUser] = await q<{ id: string; role: string; must_change_password: boolean }>(
    "select id, role, must_change_password from users where email = $1",
    [advisorEmail],
  );
  assert.equal(advisorUser!.role, "advisor");
  assert.equal(advisorUser!.must_change_password, false);
  assert.equal(asked[1]!.body.appUserId, advisorUser!.id);
  const seats = await q<{ branch_id: string }>("select branch_id from user_branch_access where user_id = $1", [advisorUser!.id]);
  assert.deepEqual(seats.map((s) => s.branch_id), [A.branch], "branch access from the advisor's policy");

  // With no key here, the route says so and asks nothing.
  const none = await call(unkeyed, "POST", `/api/users/${staffA.id}/suite-sign-in`, cookie, { actionId: randomUUID() });
  assert.equal(none.status, 503);
  assert.equal(asked.length, 2);

  // This app's own sign-in closed: no password asked for, nothing forced.
  const created = await call(closed, "POST", "/api/users", cookie, {
    email: `zz-539-new-${run}@example.com`,
    fullName: "ZZ TEST passwordless",
    role: "staff",
    accessScope: "selected_branches",
    branchIds: [A.branch],
    phoneNumber: "0815390004",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.mustChangePassword, false);
  assert.equal(created.body.phoneE164, "+66815390004");
  await q("update users set must_change_password = true, phone_verified = false, phone_e164 = '+66815390005' where id = $1", [adminA.id]);
  const me = await call(closed, "GET", "/api/user", cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.mustChangePassword, false, "never sent to the app's /change-password");
  assert.equal(me.body.phoneVerified, true, "never stopped at the app's SMS phone check");
  const meLegacy = await call(legacy, "GET", "/api/user", cookie);
  assert.equal(meLegacy.body.mustChangePassword, true, "a legacy deployment keeps its own rule");

  console.log("suite-sign-in-routes.check: all checks passed");
} finally {
  for (const child of children) child.kill();
  platform.close();
  await pool.end();
}
