// seed: its own — one park group of ZZ TEST rows, made here. Not a Playwright
// file (the suite collects *.spec.ts and *.test.ts; this is neither): it boots
// the app's real routes and needs a database with the otoapp schema migrated.
//
// The Fix module over HTTP, on the routes as registered:
//
// SCRUM-656 — an urgent report alerts the Fix Department in the app:
//   1. A report created "urgent" (the highest of the schema's priorities)
//      puts one fix_report_urgent notification in the inbox of each Fix
//      Department member, naming the report's title and branch.
//   2. Its author is not told of their own report, even when a member, and a
//      login outside the Fix Department is not told at all.
//   3. A "normal" report notifies nobody.
//   4. The notification's link (the client's own notificationTarget) is the
//      Fix Board with the report's id, and that id opens the report for the
//      member who was told.
//
// Usage, from apps/oto-app, with DATABASE_URL naming a database whose otoapp
// schema the app's migrator has built:
//   npx tsx tests/fix-module.check.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { notificationTarget } from "../client/src/lib/notification-target";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("fix-module.check: DATABASE_URL is not set");
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
const SESSION_SECRET = randomBytes(24).toString("hex");
const JPEG = readFileSync(join(APP_DIR, "tests", "fixtures", "media", "checklist-evidence.jpg"));
const run = randomBytes(3).toString("hex");

// ─── One park group: two branches, the Fix Department and another ───────────

await q("insert into tenants (name, slug) values ('OTO Default', 'default') on conflict (slug) do nothing");
const tenant = randomUUID();
await q("insert into tenants (id, name, slug) values ($1, $2, $3)", [tenant, `ZZ TEST fix ${run}`, `zz-fix-${run}`]);
async function branch(label: string) {
  const id = randomUUID();
  await q("insert into branches (id, tenant_id, name, address, timezone) values ($1, $2, $3, 'ZZ TEST', 'Asia/Bangkok')", [
    id,
    tenant,
    `ZZ TEST ${label} ${run}`,
  ]);
  return { id, name: `ZZ TEST ${label} ${run}` };
}
const branchA = await branch("Patong");
const branchB = await branch("Central");

async function department(label: string) {
  const id = randomUUID();
  await q("insert into departments (id, tenant_id, name) values ($1, $2, $3)", [id, tenant, `ZZ TEST ${label} ${run}`]);
  return id;
}
const fixDept = await department("Maintenance");
const otherDept = await department("Reception");
await q("insert into settings (tenant_id, key, value) values ($1, 'fix_department_id', $2)", [tenant, fixDept]);

interface Login {
  label: string;
  id: string;
  email: string;
}
/** A login with an employee record in `dept`, reaching `reach` (a list of branches, or every branch). */
async function login(label: string, role: string, dept: string | null, reach: string[] | "all"): Promise<Login> {
  const id = randomUUID();
  const email = `zz-fix-${label.toLowerCase()}-${run}@example.com`;
  await q(
    `insert into users (id, email, password, full_name, role, is_active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`,
    [id, email, hash(PASSWORD), `ZZ TEST ${label} ${run}`, role],
  );
  if (reach === "all") {
    await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, null, 'all_branches')", [tenant, id]);
  } else {
    for (const b of reach) {
      await q("insert into user_branch_access (tenant_id, user_id, branch_id, access_scope) values ($1, $2, $3, 'selected_branches')", [
        tenant,
        id,
        b,
      ]);
    }
  }
  if (dept) {
    await q(
      `insert into employees (id, tenant_id, branch_id, user_id, full_name, nickname, email, status, primary_department_id)
       values ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [randomUUID(), tenant, reach === "all" ? branchA.id : reach[0], id, `ZZ TEST ${label} ${run}`, label, email, dept],
    );
  }
  return { label, id, email };
}

const author = await login("Author", "staff", otherDept, [branchA.id, branchB.id]);
const fixerAll = await login("FixerAll", "staff", fixDept, "all");
const fixerA = await login("FixerA", "staff", fixDept, [branchA.id]);
const outsider = await login("Outsider", "staff", otherDept, [branchA.id, branchB.id]);

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
  SESSION_SECRET,
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
async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; form?: FormData } = {}): Promise<Answer> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
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
  const cookie: Record<string, string> = {};
  for (const who of [author, fixerAll, fixerA, outsider]) cookie[who.label] = await signIn(who.email);

  /** What the Fix page sends (client/src/pages/core/fix.tsx): the photo first, then the report. */
  const report = async (who: Login, title: string, priority: string, branchId: string) => {
    const form = new FormData();
    form.append("media", new Blob([JPEG], { type: "image/jpeg" }), "photo.jpg");
    const upload = await call("POST", "/api/fix-reports/upload", { cookie: cookie[who.label], form });
    assert.equal(upload.status, 200, `upload: ${show(upload)}`);
    const res = await call("POST", "/api/fix-reports", {
      cookie: cookie[who.label],
      body: { media: upload.body.urls, title, priority, branchId, tags: [] },
    });
    assert.equal(res.status, 201, `report: ${show(res)}`);
    return res.body as { id: string; assignedDepartmentId: string | null };
  };
  type Note = { id: string; type: string; title: string; body: string; referenceType: string | null; referenceId: string | null };
  const inbox = async (who: Login, reportId: string) => {
    const res = await call("GET", "/api/notifications", { cookie: cookie[who.label] });
    assert.equal(res.status, 200, `${who.label}'s inbox: ${show(res)}`);
    return (res.body as Note[]).filter((n) => n.referenceId === reportId);
  };

  // ─── SCRUM-656 ─────────────────────────────────────────────────────────────

  const urgentTitle = `ZZ TEST slide handrail loose ${run}`;
  const urgent = await report(author, urgentTitle, "urgent", branchA.id);

  await check("656: an urgent report is assigned to the Fix Department", () => {
    assert.equal(urgent.assignedDepartmentId, fixDept);
  });

  await check("656: each Fix Department member gets one fix_report_urgent naming the title and branch", async () => {
    for (const who of [fixerAll, fixerA]) {
      const notes = await inbox(who, urgent.id);
      assert.equal(notes.length, 1, `${who.label}: ${JSON.stringify(notes)}`);
      assert.equal(notes[0].type, "fix_report_urgent");
      assert.equal(notes[0].referenceType, "fix_report");
      assert.ok(notes[0].title.includes(urgentTitle.slice(0, 50)), `title: ${notes[0].title}`);
      assert.ok(notes[0].body.includes(branchA.name), `body: ${notes[0].body}`);
    }
  });

  await check("656: the author and a login outside the Fix Department are not told", async () => {
    assert.deepEqual(await inbox(author, urgent.id), []);
    assert.deepEqual(await inbox(outsider, urgent.id), []);
  });

  await check("656: a member who reports urgently is not told of their own report; the others are", async () => {
    const own = await report(fixerAll, `ZZ TEST own urgent ${run}`, "urgent", branchA.id);
    assert.deepEqual(await inbox(fixerAll, own.id), []);
    assert.equal((await inbox(fixerA, own.id)).length, 1);
  });

  await check("656: a normal report notifies nobody", async () => {
    const normal = await report(author, `ZZ TEST normal ${run}`, "normal", branchA.id);
    for (const who of [fixerAll, fixerA, author, outsider]) assert.deepEqual(await inbox(who, normal.id), [], who.label);
  });

  await check("656: the notification opens the report on the Fix Board", async () => {
    const [note] = await inbox(fixerA, urgent.id);
    const target = notificationTarget(note);
    assert.equal(target, `/core/fix-board?reportId=${urgent.id}`);
    const reportId = new URL(target!, ORIGIN).searchParams.get("reportId");
    const opened = await call("GET", `/api/fix-reports/${reportId}`, { cookie: cookie[fixerA.label] });
    assert.equal(opened.status, 200, show(opened));
    assert.equal(opened.body.id, urgent.id);
    // The page the link names is a route, and it reads the id it is given.
    const routes = readFileSync(join(APP_DIR, "client", "src", "App.tsx"), "utf8");
    assert.ok(routes.includes('path="/core/fix-board"'), "no /core/fix-board route");
    const board = readFileSync(join(APP_DIR, "client", "src", "pages", "core", "fix-board.tsx"), "utf8");
    assert.ok(board.includes(".get('reportId')"), "the Fix Board does not read ?reportId=");
  });

  console.log(`fix-module.check: ${checks} checks passed`);
} catch (err) {
  console.error("fix-module.check FAILED:", err);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await pool.end();
}
