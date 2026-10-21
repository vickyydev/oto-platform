// seed: its own — two park groups of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-651 — a kiosk device made through Setup belongs to its branch's park
// group, so its session can be minted without editing the row by hand:
//
//   1. POST /api/kiosk-devices writes the branch's park group on the device,
//      and the secret it returns mints a session (POST /api/kiosk/refresh-session)
//      recorded for that park group.
//   2. Another park group's branch is a 404, and no device is written.
//   3. The edits keep the park group: PATCH /api/kiosk-devices/:id and
//      PATCH /api/kiosk-devices/:deviceId/name leave it, and the session still
//      mints afterwards.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/kiosk-devices.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("kiosk-devices.check: DATABASE_URL is not set");
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

// ─── Two park groups, each with an operator and a branch ────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
async function parkGroup(label: string) {
  const tenant = randomUUID();
  await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST kiosk ${label} ${run}`, `zz-kiosk-${label}-${run}`]);
  const operator = randomUUID();
  await q("insert into operators (id, tenant_id, name) values ($1, $2, $3)", [operator, tenant, `ZZ TEST kiosk ${label} ${run}`]);
  const branch = randomUUID();
  await q(
    "insert into branches (id, tenant_id, operator_id, name, address, timezone) values ($1, $2, $3, $4, 'ZZ TEST', 'Asia/Bangkok')",
    [branch, tenant, operator, `ZZ TEST kiosk ${label} ${run}`],
  );
  return { tenant, operator, branch };
}
const A = await parkGroup("a");
const B = await parkGroup("b");

const admin = { id: randomUUID(), email: `zz-kiosk-admin-${run}@example.com` };
await q(
  `insert into users (id, email, password, full_name, role, is_active, must_change_password, operator_id)
   values ($1, $2, $3, $4, 'operator_admin', true, false, $5)`,
  [admin.id, admin.email, hash(PASSWORD), `ZZ TEST Kiosk Admin ${run}`, A.operator],
);
await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
  A.tenant,
  admin.id,
  A.branch,
]);

const deviceRow = async (id: string) =>
  (await q<{ tenant_id: string | null; branch_id: string; name: string | null }>(
    "select tenant_id, branch_id, name from kiosk_devices where id = $1",
    [id],
  ))[0];

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

try {
  ORIGIN = await serve();
  const cookie = await signIn(admin.email);
  let deviceId = "";
  let deviceSecret = "";

  /** What a kiosk tablet sends to reconnect (client/src/pages/kiosk/reception.tsx), answered with a fresh session. */
  const mint = async () => {
    const res = await call("POST", "/api/kiosk/refresh-session", { body: { deviceId, deviceSecret } });
    assert.equal(res.status, 200, show(res));
    assert.equal(typeof res.body.token, "string");
    assert.equal(res.body.device.id, deviceId);
    return res;
  };

  await check("a device made in Setup carries its branch's park group", async () => {
    const res = await call("POST", "/api/kiosk-devices", { cookie, body: { branchId: A.branch, name: `ZZ TEST tablet ${run}` } });
    assert.equal(res.status, 201, show(res));
    deviceId = res.body.id;
    deviceSecret = res.body.deviceSecret;
    assert.equal(typeof deviceSecret, "string");
    assert.equal(res.body.tenantId, A.tenant, show(res));
    assert.deepEqual(await deviceRow(deviceId), { tenant_id: A.tenant, branch_id: A.branch, name: `ZZ TEST tablet ${run}` });
  });

  await check("its secret mints a session, recorded for that park group", async () => {
    await mint();
    const sessions = await q<{ tenant_id: string }>("select tenant_id from kiosk_sessions where kiosk_device_id = $1", [deviceId]);
    assert.deepEqual(sessions.map((s) => s.tenant_id), [A.tenant]);
  });

  await check("another park group's branch is a 404, and no device is written", async () => {
    const name = `ZZ TEST foreign tablet ${run}`;
    const res = await call("POST", "/api/kiosk-devices", { cookie, body: { branchId: B.branch, name } });
    assert.equal(res.status, 404, show(res));
    assert.equal((await q("select 1 from kiosk_devices where name = $1", [name])).length, 0);
  });

  await check("an unknown branch is a 404 too", async () => {
    const res = await call("POST", "/api/kiosk-devices", { cookie, body: { branchId: randomUUID(), name: `ZZ TEST ghost ${run}` } });
    assert.equal(res.status, 404, show(res));
  });

  await check("the edits keep the park group, and the session still mints", async () => {
    const patched = await call("PATCH", `/api/kiosk-devices/${deviceId}`, { cookie, body: { name: `ZZ TEST renamed ${run}`, isActive: true } });
    assert.equal(patched.status, 200, show(patched));
    const renamed = await call("PATCH", `/api/kiosk-devices/${deviceId}/name`, { cookie, body: { name: `ZZ TEST named ${run}` } });
    assert.equal(renamed.status, 200, show(renamed));
    assert.deepEqual(await deviceRow(deviceId), { tenant_id: A.tenant, branch_id: A.branch, name: `ZZ TEST named ${run}` });
    await mint();
  });

  console.log(`kiosk-devices.check: ${checks} checks passed`);
} catch (err) {
  console.error("kiosk-devices.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
