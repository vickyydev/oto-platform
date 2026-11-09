// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// SCRUM-769 / SCRUM-770 — what an ended employment reaches, over HTTP against
// the routes as registered. The owner's rule from SCRUM-794 stands: during the
// notice, up to and including the last working day, everything works as
// usual. So, for the day after the last working day:
//
//   1. Offboard (a last day still to come) keeps the login on with full access
//      and the status active: Offboard sets neither the switch nor pay only.
//      Offboard with a last day already past puts the login in pay only at
//      once — never switched off — the platform's restriction queued, and the
//      kiosk refuses the clock-in.
//   2. The 03:00 batch on the night after the last day: the leaver is ended
//      (resigned, Left), the login stays ON in pay only, and the platform is
//      asked to restrict the account (a 'restrict' event, migration 0044), never
//      to switch it off; a profile still in its notice is untouched; a login an
//      administrator switched off stays off (marked pay only, so switching it
//      back on would reach My pay alone).
//   3. The leaver signs in: who they are and their own payslips answer 200;
//      a schedule route, a checklist route, their profile, the notifications
//      and the stored files answer 403 EMPLOYMENT_ENDED in words — where the
//      colleague still in their notice gets 200 from the same routes. No
//      notification is addressed to the login, and the lists of staff to
//      assign or schedule leave it out. Signing out works.
//   4. The kiosk: the leaver's phone fallback and the face road (face on, a
//      second server with the matcher stood in) are refused with "Employment
//      ended; see reception" and write no time record; the colleague in their
//      notice clocks in and out. A person whose old profile has ended and who
//      works under a second one sharing the phone number (SCRUM-794's
//      duplicate shape) clocks in on the one they work under by phone, and the
//      face road sends a match on the old one to the phone road.
//   5. Onboard Again with a start date of today starts the employment at once:
//      the login reaches the whole app again, the pending restriction is
//      withdrawn, and the kiosk takes the clock-in.
//   6. A last working day moved later after the batch: the edit gives the
//      login the whole app back at once and the next batch leaves it; a last
//      day moved later outside the edit is given back by the batch itself.
//   7. The administrator's switch-off still wins: that login cannot sign in.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built (CI's OTO App job runs exactly this):
//   npx tsx tests/employee-left-access.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { EMPLOYMENT_ENDED, KIOSK_EMPLOYMENT_ENDED_MESSAGE, PAY_ONLY_MESSAGE } from "../shared/payOnly";
import { payOnlyRefuses } from "../server/lib/payOnlyRoutes";
import { employmentEndedOn } from "../server/lib/employmentEnded";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("employee-left-access.check: DATABASE_URL is not set");
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
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const PASSWORD = "zz-test-password";
const run = randomBytes(3).toString("hex");
const DAY_MS = 86_400_000;
/** Bangkok's calendar day, as the offboarding route and the night batch compare days. */
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** 03:00 in Bangkok on a day, the 03:00 batch's hour, as an instant. */
const threeAmBangkok = (day: string) => new Date(Date.parse(`${day}T03:00:00+07:00`)).toISOString();

const LAST_DAY = plus(1);
const NIGHT_AFTER = plus(2);

// ─── One park group, one branch, the people ──────────────────────────────────

const TENANT = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [TENANT, `ZZ TEST s769 ${run}`, `zz-s769-${run}`]);
const BRANCH = randomUUID();
await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
  BRANCH, TENANT, `ZZ TEST s769 ${run}`,
]);
const DEPARTMENT = randomUUID();
await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [DEPARTMENT, TENANT, `ZZ TEST s769 floor ${run}`]);
const TEMPLATE = randomUUID();
await q("insert into templates (id, tenant_id, name, html_body) values ($1, $2, $3, '<p>ZZ</p>')", [TEMPLATE, TENANT, `ZZ TEST s769 ${run}`]);

async function user(role: string, label: string, scope: "all_branches" | "selected_branches") {
  const id = randomUUID();
  const email = `zz-s769-${label}-${run}@example.com`;
  // Platform-linked, so a switch-off of this login would be queued for the platform (migration 0031).
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password, platform_user_id)
     values ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, email, hash(PASSWORD), `ZZ TEST s769 ${label} ${run}`, role, randomUUID()],
  );
  await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, $4)", [
    TENANT, id, scope === "all_branches" ? null : BRANCH, scope,
  ]);
  return { id, email };
}
const admin = await user("admin", "admin", "all_branches");
const leaverLogin = await user("staff", "leaver", "selected_branches");
const noticeLogin = await user("staff", "notice", "selected_branches");
const returnerLogin = await user("staff", "returner", "selected_branches");
const disabledLogin = await user("staff", "disabled", "selected_branches");
const managerLeaverLogin = await user("manager", "managerleaver", "selected_branches");
const backdatedLogin = await user("staff", "backdated", "selected_branches");
const extendedLogin = await user("staff", "extended", "selected_branches");
const clearedLogin = await user("staff", "cleared", "selected_branches");

const phoneOf = () => `08${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
async function employee(label: string, userId: string | null, phoneLocal: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, employment_state, primary_department_id, phone_e164)
     values ($1, $2, $3, $4, $5, $6, $7, 'active', 'ACTIVE', $8, $9)`,
    [id, TENANT, BRANCH, userId, `ZZ TEST s769 ${label} ${run}`, label, `zz-s769-emp-${label}-${run}@example.com`, DEPARTMENT, `+66${phoneLocal.slice(1)}`],
  );
  return id;
}
const PHONE = {
  leaver: phoneOf(), notice: phoneOf(), returner: phoneOf(), disabled: phoneOf(), managerLeaver: phoneOf(),
  backdated: phoneOf(), extended: phoneOf(), cleared: phoneOf(), twin: phoneOf(),
};
const leaver = await employee("leaver", leaverLogin.id, PHONE.leaver);
const notice = await employee("notice", noticeLogin.id, PHONE.notice);
const returner = await employee("returner", returnerLogin.id, PHONE.returner);
const disabled = await employee("disabled", disabledLogin.id, PHONE.disabled);
const managerLeaver = await employee("managerleaver", managerLeaverLogin.id, PHONE.managerLeaver);
const backdated = await employee("backdated", backdatedLogin.id, PHONE.backdated);
const extended = await employee("extended", extendedLogin.id, PHONE.extended);
const cleared = await employee("cleared", clearedLogin.id, PHONE.cleared);

// SCRUM-794's duplicate shape, before a fold: the person's first profile ended
// days ago (resigned, Left), and a second profile made for them is the one
// they work under now. Both carry the phone number; the older one comes first.
const original = randomUUID();
await q(
  `insert into employees (id, tenant_id, branch_id, full_name, nickname, email, status, employment_state, primary_department_id,
                          phone_e164, last_working_day, created_at)
   values ($1, $2, $3, $4, 'original', $5, 'resigned', 'LEFT', $6, $7, $8, now() - interval '30 days')`,
  [original, TENANT, BRANCH, `ZZ TEST s769 original ${run}`, `zz-s769-emp-original-${run}@example.com`, DEPARTMENT,
    `+66${PHONE.twin.slice(1)}`, `${plus(-3)}T00:00:00Z`],
);
const duplicate = await employee("duplicate", null, PHONE.twin);

// The face tablet the phone fallback runs on, as tests/attendance.check.ts pairs one.
const DEVICE_SECRET = randomBytes(32).toString("hex");
const DEVICE = randomUUID();
await q(
  `insert into kiosk_devices (id, tenant_id, branch_id, name, device_secret_hash, kiosk_type, is_active)
   values ($1, $2, $3, 'ZZ TEST s769 face tablet', $4, 'face_recognition', true)`,
  [DEVICE, TENANT, BRANCH, sha256(DEVICE_SECRET)],
);

// A directory key for the night batch, as script/directory-client.mjs issues them.
const JOBS_KEY = "odk_" + randomBytes(32).toString("base64url");
await q("insert into directory_clients (tenant_id, name, key_hash, scopes) values ($1, $2, $3, $4)", [
  TENANT, `ZZ TEST s769 ${run}`, sha256(JOBS_KEY), ["jobs:run"],
]);

// ─── The servers ─────────────────────────────────────────────────────────────

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

/** The app's routes on the harness; with `fakeNow`, on a clock that starts at that instant. */
async function serve(fakeNow?: string, env: Record<string, string> = {}, script = "tests/harness/serve-routes.ts"): Promise<string> {
  const tsx = join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, script], {
    cwd: APP_DIR,
    env: { ...process.env, ...HARNESS_ENV, ...env, ...(fakeNow ? { HARNESS_FAKE_NOW: fakeNow } : {}) },
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

async function call(origin: string, method: string, path: string, cookie: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the message.
  }
  return { status: res.status, body: parsed };
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)}`;

async function signIn(origin: string, email: string): Promise<{ status: number; cookie: string; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the sign-in's JSON answer
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), body };
}

interface NightStep { step: string; ok: boolean; counts: Record<string, number>; error?: string }

/** The 03:00 batch for this park group, as the platform's runner asks for it, on the server named. */
async function reconcileAt(origin: string): Promise<NightStep[]> {
  const res = await fetch(`${origin}/api/directory/jobs/reconcile/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${JOBS_KEY}` },
    body: JSON.stringify({ tenantId: TENANT }),
  });
  const body = await res.json() as { ok: boolean; steps: NightStep[] };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.steps;
}

let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const login = async (userId: string) =>
  (await q<{ is_active: boolean; access_mode: string }>("select is_active, access_mode from users where id = $1", [userId]))[0]!;
const profile = async (id: string) =>
  (await q<{ status: string; employment_state: string }>("select status, employment_state from employees where id = $1", [id]))[0]!;
/** What the platform has been asked about the login (SCRUM-769: a restriction, never a switch-off, for a leaver), as kind:state. */
const lifecycle = async (userId: string) =>
  (await q<{ kind: string; state: string }>("select kind, state from login_lifecycle_events where user_id = $1 order by created_at, id", [userId]))
    .map((r) => `${r.kind}:${r.state}`);
const written = async (employeeId: string) => ({
  timeEvents: Number((await q<{ n: string }>("select count(*) as n from time_events where employee_id = $1", [employeeId]))[0]!.n),
  timeEntries: Number((await q<{ n: string }>("select count(*) as n from time_entries where employee_id = $1", [employeeId]))[0]!.n),
  issues: Number((await q<{ n: string }>("select count(*) as n from timekeeping_issues where employee_id = $1", [employeeId]))[0]!.n),
});
const NOTHING = { timeEvents: 0, timeEntries: 0, issues: 0 };
const notificationsTo = async (userId: string) =>
  Number((await q<{ n: string }>("select count(*) as n from notifications where recipient_user_id = $1", [userId]))[0]!.n);

/** The routes the colleague in their notice reads with 200, and the leaver is refused. */
const INTERNAL = [
  ["a schedule route", `/api/rota?scope=me&branchId=${BRANCH}&from=${plus(-7)}&to=${plus(7)}`],
  ["a checklist route", `/api/checklists/today?branchId=${BRANCH}`],
  ["their profile (My Account)", "/api/my-account/employee-info"],
] as const;

try {
  // ── 0. The rule, on its own ────────────────────────────────────────────────
  console.log("0. the rules, on their own:");
  await check("pay only reaches the user, sign-out, the hand-off, its own payslips and the signing pages — nothing else under /api or /uploads", () => {
    for (const [method, path] of [
      ["GET", "/api/user"], ["GET", "/api/user/"], ["HEAD", "/api/user"], ["POST", "/api/logout"], ["POST", "/api/auth/handoff"],
      ["GET", "/api/auth/sign-in-options"], ["PUT", "/api/platform/preferences"],
      ["GET", "/api/payroll/me/payslips"], ["GET", `/api/payroll/me/payslips/${randomUUID()}`], ["GET", "/API/Payroll/Me/Payslips"],
      ["GET", "/api/signing/zz-token"], ["POST", "/api/signing/zz-token/sign"], ["GET", "/api/letter-sign/zz-token"],
      ["GET", "/"], ["GET", "/payroll/me/payslips"], ["GET", "/assets/index.js"],
    ] as const) {
      assert.equal(payOnlyRefuses(method, path), false, `${method} ${path} stays open`);
    }
    for (const [method, path] of [
      ["GET", "/api/rota"], ["GET", "/api/employees"], ["GET", "/api/notifications"], ["POST", "/api/user"],
      ["GET", "/api/payroll/history"], ["GET", "/api/payroll/me/payslips/x/y"], ["POST", "/api/payroll/me/payslips"],
      ["POST", "/api/change-password-x"], ["GET", "/api/kiosk/clock"], ["GET", "/uploads/profile-photos/zz.jpg"],
      ["GET", "/api"], ["GET", "/API/ROTA"],
    ] as const) {
      assert.equal(payOnlyRefuses(method, path), true, `${method} ${path} is refused`);
    }
  });
  await check("the kiosk's measure: ended the day after the last working day, never during the notice, never once Onboard Again has started", () => {
    const at = (day: string) => new Date(`${day}T00:00:00Z`);
    assert.equal(employmentEndedOn({ status: "resigned", employmentState: "LEFT", lastWorkingDay: at(plus(-1)) }, today), true);
    assert.equal(employmentEndedOn({ status: "terminated", employmentState: "LEAVING", lastWorkingDay: at(plus(-1)) }, today), true);
    assert.equal(employmentEndedOn({ status: "resigned", employmentState: "LEAVING", lastWorkingDay: at(today) }, today), false, "the last day itself");
    assert.equal(employmentEndedOn({ status: "active", employmentState: "LEAVING", lastWorkingDay: at(plus(3)) }, today), false, "the notice");
    assert.equal(employmentEndedOn({ status: "active", employmentState: "ACTIVE", lastWorkingDay: null }, today), false);
    assert.equal(employmentEndedOn({ status: "resigned", employmentState: "LEFT", lastWorkingDay: null }, today), true);
    assert.equal(employmentEndedOn({ status: "resigned", employmentState: "LEFT", lastWorkingDay: at(plus(-5)) }, today, true), false, "a new employment starting today");
  });

  // ── 1. Offboard ────────────────────────────────────────────────────────────
  console.log("1. offboard, the last working day still to come:");
  const day0 = await serve();
  const adminNow = (await signIn(day0, admin.email)).cookie;
  const offboard = (id: string, lastWorkingDay: string) => call(day0, "POST", `/api/employees/${id}/offboarding`, adminNow, {
    offboardingType: "resignation", reasonCode: "personal_reasons", lastWorkingDay,
  });
  await check("Offboard keeps the login on with full access and the profile active (SCRUM-794): it sets neither switch", async () => {
    for (const [id, last] of [
      [leaver, LAST_DAY], [returner, LAST_DAY], [disabled, LAST_DAY], [managerLeaver, LAST_DAY], [extended, LAST_DAY], [cleared, LAST_DAY],
      [notice, plus(10)],
    ] as const) {
      const res = await offboard(id, last);
      assert.equal(res.status, 201, show(res));
      assert.deepEqual(await profile(id), { status: "active", employment_state: "LEAVING" });
    }
    for (const u of [leaverLogin, returnerLogin, disabledLogin, managerLeaverLogin, extendedLogin, clearedLogin, noticeLogin]) {
      assert.deepEqual(await login(u.id), { is_active: true, access_mode: "full" });
      assert.deepEqual(await lifecycle(u.id), []);
    }
  });
  await check("Offboard with a last day already past ends the employment at once: the login stays on, in pay only, the platform asked to restrict it, never to switch it off", async () => {
    const res = await offboard(backdated, plus(-1));
    assert.equal(res.status, 201, show(res));
    assert.deepEqual(await profile(backdated), { status: "resigned", employment_state: "LEFT" });
    assert.deepEqual(await login(backdatedLogin.id), { is_active: true, access_mode: "pay_only" });
    assert.deepEqual(await lifecycle(backdatedLogin.id), ["restrict:pending"]);
    const signedIn = await signIn(day0, backdatedLogin.email);
    assert.deepEqual([signedIn.status, signedIn.body?.accessMode], [200, "pay_only"], JSON.stringify(signedIn.body));
  });
  await check("the backdated leaver's clock-in is refused at the kiosk the same day, with nothing written", async () => {
    const res = await call(day0, "POST", "/api/kiosk/clock-phone", "", { phone: PHONE.backdated, photoEvidenceUrl: "", deviceSecret: DEVICE_SECRET });
    assert.deepEqual([res.status, res.body.reasonCode, res.body.message], [403, EMPLOYMENT_ENDED, KIOSK_EMPLOYMENT_ENDED_MESSAGE], show(res));
    assert.deepEqual(await written(backdated), NOTHING);
  });
  await check("an administrator switches one leaver's login off by hand, in the notice: that is a switch-off for the platform", async () => {
    const res = await call(day0, "POST", `/api/employees/${disabled}/toggle-login`, adminNow);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(await login(disabledLogin.id), { is_active: false, access_mode: "full" });
    assert.deepEqual(await lifecycle(disabledLogin.id), ["deactivate:pending"]);
  });

  // ── 2. The night after the last working day ───────────────────────────────
  console.log("2. the 03:00 batch on the night after the last working day:");
  const night = await serve(threeAmBangkok(NIGHT_AFTER));
  await check("the leaver is ended — resigned, Left — and the login stays on, in pay only; the platform is asked to restrict it, never to switch it off", async () => {
    const steps = await reconcileAt(night);
    const departed = steps.find((s) => s.step === "departedLogins")!.counts;
    assert.deepEqual([departed.payOnly, departed.fullAgain], [6, 0], JSON.stringify(departed));
    for (const [id, u] of [
      [leaver, leaverLogin], [returner, returnerLogin], [managerLeaver, managerLeaverLogin], [extended, extendedLogin], [cleared, clearedLogin],
    ] as const) {
      assert.deepEqual(await profile(id), { status: "resigned", employment_state: "LEFT" });
      assert.deepEqual(await login(u.id), { is_active: true, access_mode: "pay_only" });
      assert.deepEqual(await lifecycle(u.id), ["restrict:pending"]);
    }
    // Offboard put the backdated leaver there already: nothing moves, nothing more is queued.
    assert.deepEqual(await login(backdatedLogin.id), { is_active: true, access_mode: "pay_only" });
    assert.deepEqual(await lifecycle(backdatedLogin.id), ["restrict:pending"]);
  });
  await check("the colleague still in their notice is untouched: active, Leaving, full access", async () => {
    assert.deepEqual(await profile(notice), { status: "active", employment_state: "LEAVING" });
    assert.deepEqual(await login(noticeLogin.id), { is_active: true, access_mode: "full" });
  });
  await check("the login switched off by hand stays off (marked pay only, should it ever be switched back on)", async () => {
    assert.deepEqual(await login(disabledLogin.id), { is_active: false, access_mode: "pay_only" });
    assert.deepEqual(await profile(disabled), { status: "resigned", employment_state: "LEFT" });
    assert.deepEqual(await lifecycle(disabledLogin.id), ["deactivate:pending", "restrict:pending"]);
  });
  await check("a second run moves nobody again, either way", async () => {
    const steps = await reconcileAt(night);
    const departed = steps.find((s) => s.step === "departedLogins")!.counts;
    assert.deepEqual([departed.payOnly, departed.fullAgain], [0, 0], JSON.stringify(departed));
  });

  // ── 3. The leaver signs in ─────────────────────────────────────────────────
  console.log("3. the leaver signs in, to My pay alone:");
  const asLeaver = await signIn(night, leaverLogin.email);
  const asNotice = await signIn(night, noticeLogin.email);
  await check("the sign-in works and says pay only", async () => {
    assert.equal(asLeaver.status, 200, JSON.stringify(asLeaver.body));
    assert.equal(asLeaver.body.accessMode, "pay_only");
    const me = await call(night, "GET", "/api/user", asLeaver.cookie);
    assert.deepEqual([me.status, me.body.id, me.body.accessMode], [200, leaverLogin.id, "pay_only"], show(me));
  });
  await check("their own pay answers: the payslip list 200 (their own employee), a payslip file reaches its route", async () => {
    const list = await call(night, "GET", "/api/payroll/me/payslips", asLeaver.cookie);
    assert.equal(list.status, 200, show(list));
    assert.equal(list.body.employee?.id, leaver, show(list));
    assert.deepEqual(list.body.payslips, []);
    // The route answers for itself (no such payslip), not the fence.
    const file = await call(night, "GET", `/api/payroll/me/payslips/${randomUUID()}`, asLeaver.cookie);
    assert.deepEqual([file.status, file.body.message], [404, "Payslip not found"], show(file));
  });
  for (const [what, path] of INTERNAL) {
    await check(`${what}: 200 for the colleague in their notice, 403 EMPLOYMENT_ENDED in words for the leaver`, async () => {
      const working = await call(night, "GET", path, asNotice.cookie);
      assert.equal(working.status, 200, `${path} as the colleague: ${show(working)}`);
      const ended = await call(night, "GET", path, asLeaver.cookie);
      assert.deepEqual([ended.status, ended.body], [403, { reason: EMPLOYMENT_ENDED, reasonCode: EMPLOYMENT_ENDED, message: PAY_ONLY_MESSAGE }], show(ended));
    });
  }
  await check("every other door is shut too: writes, the notifications, the employee list, the stored files", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/notifications", undefined],
      ["GET", "/api/employees", undefined],
      ["POST", "/api/notifications/mark-all-read", {}],
      ["GET", "/uploads/profile-photos/zz.jpg", undefined],
    ] as const) {
      const res = await call(night, method, path, asLeaver.cookie, body);
      assert.equal(res.status, 403, `${method} ${path}: ${show(res)}`);
      assert.equal(res.body.reasonCode, EMPLOYMENT_ENDED, `${method} ${path}`);
    }
  });
  await check("no notification is addressed to the login: a task handed to the leaver tells nobody, one handed to the colleague tells them", async () => {
    const adminAtNight = (await signIn(night, admin.email)).cookie;
    for (const [to, expected] of [[leaverLogin.id, 0], [noticeLogin.id, 1]] as const) {
      const before = await notificationsTo(to);
      const made = await call(night, "POST", "/api/core/tasks", adminAtNight, { title: `ZZ TEST s769 task ${run}`, branchId: BRANCH });
      assert.equal(made.status, 201, show(made));
      const assigned = await call(night, "PATCH", `/api/core/tasks/${made.body.id}`, adminAtNight, { assignedTo: to });
      assert.equal(assigned.status, 200, show(assigned));
      assert.equal(await notificationsTo(to) - before, expected, to === leaverLogin.id ? "nothing for the leaver" : "the colleague's arrives");
    }
  });
  await check("the lists of staff leave the leavers out: the task assignee list, the event staff list", async () => {
    const adminAtNight = (await signIn(night, admin.email)).cookie;
    const assignable = await call(night, "GET", "/api/core/tasks/assignable-users", adminAtNight);
    assert.equal(assignable.status, 200, show(assignable));
    const assignableIds = (assignable.body as { id: string }[]).map((u) => u.id);
    assert.ok(assignableIds.includes(admin.id), "the administrator is listed");
    assert.ok(!assignableIds.includes(managerLeaverLogin.id), "the manager who left is not");
    const staff = await call(night, "GET", "/api/beo/staff", adminAtNight);
    assert.equal(staff.status, 200, show(staff));
    const staffIds = (staff.body as { id: string }[]).map((u) => u.id);
    assert.ok(staffIds.includes(noticeLogin.id), "the colleague in their notice is listed");
    for (const gone of [leaverLogin, managerLeaverLogin, backdatedLogin, disabledLogin]) {
      assert.ok(!staffIds.includes(gone.id), `${gone.email} is not listed`);
    }
  });
  await check("signing out works", async () => {
    const out = await call(night, "POST", "/api/logout", asLeaver.cookie);
    assert.equal(out.status, 200, show(out));
    const after = await call(night, "GET", "/api/user", asLeaver.cookie);
    assert.equal(after.status, 401, show(after));
  });

  // ── 4. The kiosk ───────────────────────────────────────────────────────────
  console.log("4. the kiosk, the day after the last working day:");
  const phoneClock = (phone: string) =>
    call(night, "POST", "/api/kiosk/clock-phone", "", { phone, photoEvidenceUrl: "", deviceSecret: DEVICE_SECRET });
  const REFUSED = { success: false, reason: EMPLOYMENT_ENDED, reasonCode: EMPLOYMENT_ENDED, message: KIOSK_EMPLOYMENT_ENDED_MESSAGE };
  await check("the leaver's phone number is refused with the plain reason, and no time record is written", async () => {
    const res = await phoneClock(PHONE.leaver);
    assert.deepEqual([res.status, res.body], [403, REFUSED], show(res));
    assert.deepEqual(await written(leaver), NOTHING);
    const attempts = await q("select outcome, fail_reason, method from kiosk_auth_attempts where employee_id = $1", [leaver]);
    assert.deepEqual(attempts, [{ outcome: "FAIL", fail_reason: "employment_ended", method: "PHONE_FALLBACK" }]);
  });
  await check("the colleague still in their notice clocks in by phone as usual", async () => {
    const res = await phoneClock(PHONE.notice);
    assert.deepEqual([res.status, res.body.eventType], [200, "IN"], show(res));
    assert.equal((await written(notice)).timeEvents, 1);
  });
  await check("one number, two profiles: the person clocks in on the profile they work under, the ended one untouched", async () => {
    const res = await phoneClock(PHONE.twin);
    assert.deepEqual([res.status, res.body.eventType], [200, "IN"], show(res));
    assert.equal((await written(duplicate)).timeEvents, 1);
    assert.deepEqual(await written(original), NOTHING);
  });
  const faceOn = await serve(threeAmBangkok(NIGHT_AFTER), { USE_AWS_REKOGNITION: "true" }, "tests/harness/serve-routes-face.ts");
  const identify = (matched: string) => call(faceOn, "POST", "/api/kiosk/identify-face", "", {
    faceImageBase64: matched, faceFramesBase64: ["zz-1", "zz-2", "zz-3"], deviceSecret: DEVICE_SECRET,
  });
  await check("the face road: a face matched to the leaver is refused in the kiosk's words; to the colleague, matched", async () => {
    const refused = await identify(leaver);
    assert.deepEqual([refused.status, refused.body], [403, REFUSED], show(refused));
    const matched = await identify(notice);
    assert.deepEqual([matched.status, matched.body.matched, matched.body.employee?.id], [200, true, notice], show(matched));
  });
  await check("the face road: a face matched to the ended profile of somebody working under another is sent to the phone road, not refused", async () => {
    const res = await identify(original);
    assert.equal(res.status, 200, show(res));
    assert.deepEqual([res.body.success, res.body.matched, res.body.message], [true, false, "No matching face found. Please clock in with your phone number."], show(res));
    assert.deepEqual(await written(original), NOTHING);
  });
  const faceClock = (employeeId: string) =>
    call(faceOn, "POST", "/api/kiosk/clock", "", { employeeId, confidenceScore: 99, livenessScore: 97, deviceSecret: DEVICE_SECRET });
  await check("with face clock-in on, the face road refuses the leaver in the same words and writes nothing", async () => {
    const res = await faceClock(leaver);
    assert.deepEqual([res.status, res.body], [403, REFUSED], show(res));
    for (const [path, body] of [
      ["/api/kiosk/unscheduled-clock-in", { employeeId: leaver, branchId: BRANCH, reasonCode: "OTHER", deviceSecret: DEVICE_SECRET }],
      ["/api/kiosk/missed-clock/auto-fix", {
        employeeId: leaver, branchId: BRANCH, scheduledStart: `${NIGHT_AFTER}T02:00:00Z`, scheduledEnd: `${NIGHT_AFTER}T10:00:00Z`,
        shiftDate: NIGHT_AFTER, deviceSecret: DEVICE_SECRET,
      }],
    ] as const) {
      const door = await call(faceOn, "POST", path, "", body);
      assert.deepEqual([door.status, door.body], [403, REFUSED], `${path}: ${show(door)}`);
    }
    assert.deepEqual(await written(leaver), NOTHING);
  });
  await check("with face clock-in on, the colleague in their notice clocks out by face as usual", async () => {
    const res = await faceClock(notice);
    assert.deepEqual([res.status, res.body.eventType], [200, "OUT"], show(res));
    assert.equal((await written(notice)).timeEvents, 2);
  });

  // ── 5. Onboard Again ───────────────────────────────────────────────────────
  console.log("5. Onboard Again with a start date of today:");
  const adminNight = (await signIn(night, admin.email)).cookie;
  await check("the employment starts at once, and the login reaches the whole app again", async () => {
    const res = await call(night, "POST", `/api/employees/${returner}/onboard-again`, adminNight, {
      startDate: NIGHT_AFTER, departmentId: DEPARTMENT, positionTitle: "ZZ Returner", templateId: TEMPLATE,
    });
    assert.equal(res.status, 201, show(res));
    assert.equal(res.body.started, true, show(res));
    assert.deepEqual(await profile(returner), { status: "active", employment_state: "ACTIVE" });
    assert.deepEqual(await login(returnerLogin.id), { is_active: true, access_mode: "full" });
    // The restriction still waiting for the platform is withdrawn: the till is the person's again.
    assert.deepEqual(await lifecycle(returnerLogin.id), ["restrict:superseded"]);
    const back = await signIn(night, returnerLogin.email);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const rota = await call(night, "GET", INTERNAL[0][1], back.cookie);
    assert.equal(rota.status, 200, show(rota));
  });
  await check("the kiosk takes the returner's clock-in", async () => {
    const res = await phoneClock(PHONE.returner);
    assert.deepEqual([res.status, res.body.eventType], [200, "IN"], show(res));
    assert.equal((await written(returner)).timeEvents, 1);
  });

  // ── 6. A last working day moved later ─────────────────────────────────────
  console.log("6. a last working day moved later, after the batch:");
  await check("the offboarding's edit gives the whole app back at once, and withdraws the restriction still waiting", async () => {
    const res = await call(night, "PATCH", `/api/employees/${extended}/offboarding`, adminNight, { lastWorkingDay: plus(5) });
    assert.equal(res.status, 200, show(res));
    assert.deepEqual(await login(extendedLogin.id), { is_active: true, access_mode: "full" });
    assert.deepEqual(await lifecycle(extendedLogin.id), ["restrict:superseded"]);
    const back = await signIn(night, extendedLogin.email);
    const rota = await call(night, "GET", INTERNAL[0][1], back.cookie);
    assert.equal(rota.status, 200, show(rota));
  });
  await check("the person back in their notice clocks in at the kiosk", async () => {
    const res = await phoneClock(PHONE.extended);
    assert.deepEqual([res.status, res.body.eventType], [200, "IN"], show(res));
  });
  await check("a last day moved later outside the edit: the batch gives the whole app back itself, and leaves the edited one as it is", async () => {
    await q("update employees set last_working_day = $2 where id = $1", [cleared, `${plus(6)}T00:00:00Z`]);
    const steps = await reconcileAt(night);
    const departed = steps.find((s) => s.step === "departedLogins")!.counts;
    assert.deepEqual([departed.payOnly, departed.fullAgain], [0, 1], JSON.stringify(departed));
    assert.deepEqual(await login(clearedLogin.id), { is_active: true, access_mode: "full" });
    assert.deepEqual(await lifecycle(clearedLogin.id), ["restrict:superseded"]);
    assert.deepEqual(await login(extendedLogin.id), { is_active: true, access_mode: "full" });
    // The leavers whose day has passed stay in pay only.
    assert.deepEqual(await login(leaverLogin.id), { is_active: true, access_mode: "pay_only" });
    assert.deepEqual(await login(backdatedLogin.id), { is_active: true, access_mode: "pay_only" });
  });

  // ── 7. The administrator's switch-off ──────────────────────────────────────
  console.log("7. the administrator's switch-off still wins:");
  await check("the login switched off by hand cannot sign in, and the batch never switched it on", async () => {
    const res = await signIn(night, disabledLogin.email);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(String(res.body?.message), /disabled/);
    assert.deepEqual(await login(disabledLogin.id), { is_active: false, access_mode: "pay_only" });
  });

  console.log(`employee-left-access.check: ${checks} checks passed`);
} catch (err) {
  console.error("employee-left-access.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
