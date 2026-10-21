// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-605 — the checks that did nothing now decide:
//
//   1. requireKioskPermission reads the session's own permission set (from its
//      device's kind): a face-recognition kiosk's session is refused a
//      check-in key, a reception kiosk's passes. Driven in this process on
//      sessions validated against the database, as the routes validate them.
//   2. hr.terminate_employee: a manager is refused a termination (the
//      offboarding create and edit, and marking the employee terminated) and
//      still records a resignation; an operator admin terminates.
//   3. hr.edit_contract_templates: an operator admin still reaches the
//      contract template routes (the gate passes; the body is what answers).
//   4. The employee PIN: set as a salted scrypt hash, refused for an employee
//      of a branch the manager does not reach; an old unsalted sha256 PIN is
//      verified once at the kiosk, re-hashed, and verified again the new way;
//      a wrong PIN still fails.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/named-rights.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("named-rights.check: DATABASE_URL is not set");
  process.exit(2);
}

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

const pool = new pg.Pool({ connectionString: DATABASE_URL, options: "-c search_path=otoapp", max: 4 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;

/** The app's own password format (`hashPassword` in server/auth.ts): scrypt, 64 bytes, then the salt. */
const hash = (password: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${scryptSync(password, salt, 64).toString("hex")}.${salt}`;
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const lastWorkingDay = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

// ─── One park group, one operator, two branches ─────────────────────────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST nr ${run}`, `zz-nr-${run}`]);
const operator = randomUUID();
await q("insert into operators (id, tenant_id, name) values ($1, $2, $3)", [operator, tenant, `ZZ TEST nr ${run}`]);
async function makeBranch(label: string) {
  const id = randomUUID();
  await q(
    "insert into branches (id, tenant_id, operator_id, name, address, timezone) values ($1, $2, $3, $4, 'ZZ TEST', 'Asia/Bangkok')",
    [id, tenant, operator, `ZZ TEST nr ${label} ${run}`],
  );
  return id;
}
const branch = await makeBranch("home");
const otherBranch = await makeBranch("other");

async function user(role: string, label: string, opts: { operatorId?: string } = {}): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `zz-nr-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, operator_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role, opts.operatorId ?? null],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
    tenant,
    id,
    branch,
  ]);
  return { id, email };
}

async function employee(label: string, branchId = branch, extra: { pinHash?: string } = {}) {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, timeclock_pin_hash)
     values ($1, $2, $3, $4, $5, $6, 'active', $7)`,
    [id, tenant, branchId, `ZZ TEST ${label} ${run}`, label, `zz-nr-e-${label.toLowerCase()}-${run}@example.com`, extra.pinHash ?? null],
  );
  return id;
}

const manager = await user("manager", "Manager");
const opAdmin = await user("operator_admin", "OpAdmin", { operatorId: operator });

const refusedTermination = await employee("RefusedTerm");
const resigning = await employee("Resigning");
const terminated = await employee("Terminated");
const statusTarget = await employee("StatusTarget");
const pinHome = await employee("PinHome");
const pinOther = await employee("PinOther", otherBranch);
const LEGACY_PIN = "4321";
const pinLegacy = await employee("PinLegacy", branch, { pinHash: sha256(LEGACY_PIN) });

// A face kiosk (device secret) for the PIN clock, and a session on it and on
// a reception kiosk for the permission check.
const deviceSecret = randomBytes(32).toString("hex");
const faceDevice = randomUUID();
await q(
  `insert into kiosk_devices (id, tenant_id, branch_id, name, device_secret_hash, kiosk_type, is_active)
   values ($1, $2, $3, 'ZZ TEST face tablet', $4, 'face_recognition', true)`,
  [faceDevice, tenant, branch, sha256(deviceSecret)],
);
const receptionDevice = randomUUID();
await q(
  `insert into kiosk_devices (id, tenant_id, branch_id, name, kiosk_type, is_active)
   values ($1, $2, $3, 'ZZ TEST reception tablet', 'reception', true)`,
  [receptionDevice, tenant, branch],
);
const SESSION_PEPPER = process.env.SESSION_PEPPER || "default-session-pepper-change-in-production";
async function kioskSession(deviceId: string) {
  const token = randomBytes(48).toString("base64url");
  await q(
    `insert into kiosk_sessions (tenant_id, kiosk_device_id, session_token_hash, expires_at)
     values ($1, $2, $3, now() + interval '1 hour')`,
    [tenant, deviceId, sha256(token + SESSION_PEPPER)],
  );
  return token;
}
const faceToken = await kioskSession(faceDevice);
const receptionToken = await kioskSession(receptionDevice);

const pinOf = async (id: string) =>
  (await q<{ timeclock_pin_hash: string | null }>("select timeclock_pin_hash from employees where id = $1", [id]))[0]?.timeclock_pin_hash;
const statusOf = async (id: string) => (await q<{ status: string }>("select status from employees where id = $1", [id]))[0]?.status;
/** The salted form pin-utils' hashPin writes: 128 hex characters, a dot, a 32-hex salt. */
const SALTED = /^[a-f0-9]{128}\.[a-f0-9]{32}$/;

// ─── The server ──────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];

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
  // ─── 1. The kiosk permission check reads the session ────────────────────

  Object.assign(process.env, HARNESS_ENV);
  await import("../server/config/env");
  const kiosk = await import("../server/kiosk-auth");
  /** requireKioskPermission on a session validated the way the routes validate one. */
  const kioskGate = async (token: string, permission: "core.checkin.read" | "core.checkin.update" | "core.guest.read_minimal") => {
    const session = await kiosk.validateKioskSession(kiosk.hashSessionToken(token));
    assert.ok(session, "the kiosk session did not validate");
    let status = 0;
    let passed = false;
    const req = { kioskSession: session } as unknown as Parameters<ReturnType<typeof kiosk.requireKioskPermission>>[0];
    const res = {
      status(code: number) {
        status = code;
        return { json: () => undefined };
      },
    } as unknown as Parameters<ReturnType<typeof kiosk.requireKioskPermission>>[1];
    kiosk.requireKioskPermission(permission)(req, res, () => {
      passed = true;
    });
    return { status, passed, session };
  };

  await check("a face-recognition kiosk's session is refused a check-in key it does not hold", async () => {
    for (const key of ["core.checkin.read", "core.checkin.update", "core.guest.read_minimal"] as const) {
      const gate = await kioskGate(faceToken, key);
      assert.deepEqual([gate.passed, gate.status], [false, 403], `${key}: ${JSON.stringify(gate.session)}`);
    }
  });

  await check("a reception kiosk's session holds the check-in keys and passes", async () => {
    for (const key of ["core.checkin.read", "core.checkin.update", "core.guest.read_minimal"] as const) {
      const gate = await kioskGate(receptionToken, key);
      assert.deepEqual([gate.passed, gate.status], [true, 0], key);
    }
  });

  ORIGIN = await serve();
  const cookie = {
    manager: await signIn(manager.email),
    opAdmin: await signIn(opAdmin.email),
  };

  // ─── 2. hr.terminate_employee ───────────────────────────────────────────

  const offboard = (who: keyof typeof cookie, employeeId: string, offboardingType: string) =>
    call("POST", `/api/employees/${employeeId}/offboarding`, {
      cookie: cookie[who],
      body: { offboardingType, reasonCode: offboardingType === "termination" ? "misconduct" : "personal_reasons", lastWorkingDay },
    });

  await check("a manager is refused a termination; the employee stays active and nothing is written", async () => {
    const res = await offboard("manager", refusedTermination, "termination");
    assert.equal(res.status, 403, show(res));
    assert.equal(await statusOf(refusedTermination), "active");
    const rows = await q("select 1 from employee_offboarding where employee_id = $1", [refusedTermination]);
    assert.equal(rows.length, 0);
  });

  await check("a manager still records a resignation", async () => {
    const res = await offboard("manager", resigning, "resignation");
    assert.ok(res.status === 200 || res.status === 201, show(res));
    assert.equal(await statusOf(resigning), "resigned");
  });

  await check("an operator admin terminates", async () => {
    const res = await offboard("opAdmin", terminated, "termination");
    assert.ok(res.status === 200 || res.status === 201, show(res));
    assert.equal(await statusOf(terminated), "terminated");
  });

  await check("a manager cannot edit a termination; the operator admin can", async () => {
    const refused = await call("PATCH", `/api/employees/${terminated}/offboarding`, { cookie: cookie.manager, body: { notes: "ZZ TEST" } });
    assert.equal(refused.status, 403, show(refused));
    const allowed = await call("PATCH", `/api/employees/${terminated}/offboarding`, { cookie: cookie.opAdmin, body: { notes: "ZZ TEST" } });
    assert.equal(allowed.status, 200, show(allowed));
  });

  await check("a manager cannot mark an employee terminated on the employee edit", async () => {
    const res = await call("PATCH", `/api/employees/${statusTarget}`, { cookie: cookie.manager, body: { status: "terminated" } });
    assert.equal(res.status, 403, show(res));
    assert.equal(await statusOf(statusTarget), "active");
  });

  // ─── 3. hr.edit_contract_templates keeps the admin roles passing ────────

  await check("an operator admin passes the contract template gate (the body answers, not the gate)", async () => {
    const res = await call("POST", "/api/templates", { cookie: cookie.opAdmin, body: {} });
    assert.equal(res.status, 400, show(res));
  });

  // ─── 4. The employee PIN ────────────────────────────────────────────────

  await check("a manager cannot set a PIN for an employee of a branch they do not reach", async () => {
    const res = await call("POST", `/api/employees/${pinOther}/pin`, { cookie: cookie.manager, body: { pin: "5555" } });
    assert.equal(res.status, 403, show(res));
    assert.equal(await pinOf(pinOther), null);
    const cleared = await call("DELETE", `/api/employees/${pinOther}/pin`, { cookie: cookie.manager });
    assert.equal(cleared.status, 403, show(cleared));
  });

  const clock = (employeeId: string, pin: string) =>
    call("POST", "/api/kiosk/clock-pin", { body: { employeeId, pin, photoEvidenceUrl: "", deviceSecret } });

  await check("a PIN set now is stored salted and clocks in", async () => {
    const res = await call("POST", `/api/employees/${pinHome}/pin`, { cookie: cookie.manager, body: { pin: "2468" } });
    assert.equal(res.status, 200, show(res));
    const stored = await pinOf(pinHome);
    assert.match(stored ?? "", SALTED);
    const again = await call("POST", `/api/employees/${pinHome}/pin`, { cookie: cookie.manager, body: { pin: "2468" } });
    assert.equal(again.status, 200, show(again));
    assert.notEqual(await pinOf(pinHome), stored, "the same PIN gave the same stored value twice");
    const ok = await clock(pinHome, "2468");
    assert.equal(ok.status, 200, show(ok));
  });

  await check("an old unsalted PIN is verified once, re-hashed, and verified again the new way", async () => {
    assert.equal(await pinOf(pinLegacy), sha256(LEGACY_PIN));
    const first = await clock(pinLegacy, LEGACY_PIN);
    assert.equal(first.status, 200, show(first));
    const stored = await pinOf(pinLegacy);
    assert.match(stored ?? "", SALTED);
    const second = await clock(pinLegacy, LEGACY_PIN);
    assert.equal(second.status, 200, show(second));
  });

  await check("a wrong PIN still fails, and does not touch what is stored", async () => {
    const before = await pinOf(pinLegacy);
    const res = await clock(pinLegacy, "9999");
    assert.equal(res.status, 401, show(res));
    assert.equal(await pinOf(pinLegacy), before);
  });

  console.log(`named-rights.check: ${checks} checks passed`);
} catch (err) {
  console.error("named-rights.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
  // The app modules loaded in this process (kiosk-auth, its storage) hold a
  // pool and timers of their own; the result is decided, so leave now.
  process.exit(process.exitCode ?? 0);
}
